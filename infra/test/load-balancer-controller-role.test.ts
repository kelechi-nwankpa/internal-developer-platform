import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ClusterStack } from '../lib/cluster-stack';

/**
 * Tests for the AWS Load Balancer Controller's IAM role (ADR-0036).
 *
 * The role is a trimmed copy of the controller's published policy. Two
 * things can go wrong with a trimmed policy and both are silent:
 *   - it allows too much (nobody notices until it is abused), or
 *   - it allows too little, or misspells an action (IAM accepts unknown
 *     action names; the NLB then fails in a billed session).
 * So the policy is pinned here in full, and compared with upstream.
 */

const ACCOUNT = '123456789012';
const REGION = 'eu-west-1';

// The published policy, unmodified, kept only to compare against.
const UPSTREAM_FILE = join(__dirname, 'fixtures', 'aws-load-balancer-controller-v3.6.3-iam-policy.json');
const UPSTREAM_SHA256 = '16f232c9d9f79366fe949c4550ad517a202380058a9e48d45a4e215044a20a6a';

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

/**
 * Turns CloudFormation intrinsics into readable text, so a test can say
 * `arn:<partition>:ec2:eu-west-1:123456789012:security-group/*` instead
 * of a nested Fn::Join.
 */
function flat(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(flat);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const [k] = keys;
    if (k === 'Ref') return o[k] === 'AWS::Partition' ? '<partition>' : `<ref:${String(o[k])}>`;
    if (k === 'Fn::Join') {
      const [sep, parts] = o[k] as [string, unknown[]];
      return (flat(parts) as unknown[]).join(sep);
    }
    if (k === 'Fn::ImportValue') return /VpcId|HarnessVpc/.test(JSON.stringify(o[k])) ? '<project-vpc-id>' : '<import>';
    if (k === 'Fn::GetAtt') return `<attr:${(o[k] as string[]).join('.')}>`;
    if (k === 'Fn::Select' || k === 'Fn::Split') return '<oidc-issuer>';
  }
  return Object.fromEntries(keys.map((k) => [k, flat(o[k])]));
}

function synth(clusterName?: string) {
  const app = new cdk.App();
  const scaffold = new cdk.Stack(app, 'ScaffoldStack', { env: { account: ACCOUNT, region: REGION } });
  const vpc = new ec2.Vpc(scaffold, 'HarnessVpc', {
    maxAzs: 3,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'pub', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'p', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
    ],
  });
  const stack = new ClusterStack(app, 'TestClusterStack', {
    env: { account: ACCOUNT, region: REGION },
    vpc,
    eksSecretsKey: new kms.Key(scaffold, 'HarnessKey'),
    ...(clusterName ? { clusterName } : {}),
  });
  const template = Template.fromStack(stack);

  const roles = template.findResources('AWS::IAM::Role', {
    Properties: { Description: cdk.assertions.Match.stringLikeRegexp('AWS Load Balancer Controller') },
  });
  const [roleId] = Object.keys(roles);
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles).includes(roleId));

  return {
    template,
    roleCount: Object.keys(roles).length,
    role: roles[roleId],
    policyCount: policies.length,
    statements: flat(policies[0].Properties.PolicyDocument.Statement) as Statement[],
  };
}

const actionsOf = (s: Statement) => ([] as string[]).concat(s.Action);
const resourcesOf = (s: Statement) => ([] as string[]).concat(s.Resource as string | string[]);
const isRead = (action: string) => /^[a-z0-9-]+:(Describe|Get|List)[A-Z]/.test(action);

const SG = `arn:<partition>:ec2:${REGION}:${ACCOUNT}:security-group/*`;
const VPC = `arn:<partition>:ec2:${REGION}:${ACCOUNT}:vpc/<project-vpc-id>`;
const NLB = `arn:<partition>:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/net/*/*`;
const TG = `arn:<partition>:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/*/*`;
const LISTENER = `arn:<partition>:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/net/*/*/*`;
const TAG = 'elbv2.k8s.aws/cluster';

describe('LoadBalancerControllerRole', () => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    t = synth();
  });

  const bySid = (sid: string) => {
    const s = t.statements.find((x) => x.Sid === sid);
    if (!s) throw new Error(`no statement ${sid}`);
    return s;
  };

  describe('who may use the role', () => {
    it('is one role with one inline policy and no managed policies', () => {
      expect(t.roleCount).toBe(1);
      expect(t.policyCount).toBe(1);
      expect(t.role.Properties.ManagedPolicyArns).toBeUndefined();
    });

    it('has no fixed name (an `idp-` name would also match the teardown sweep)', () => {
      expect(t.role.Properties.RoleName).toBeUndefined();
    });

    it('trusts only the cluster OIDC provider, only through a web identity token', () => {
      const trust = t.role.Properties.AssumeRolePolicyDocument.Statement;
      expect(trust).toHaveLength(1);
      expect(trust[0].Effect).toBe('Allow');
      expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(Object.keys(trust[0].Principal)).toEqual(['Federated']);
      expect(JSON.stringify(trust[0].Principal.Federated)).toMatch(/OpenIdConnectProvider/);
    });

    it('accepts exactly one ServiceAccount, and only tokens issued for STS', () => {
      const trust = t.role.Properties.AssumeRolePolicyDocument.Statement[0];
      // Only exact-match conditions: a StringLike here could let in a wildcard.
      expect(Object.keys(trust.Condition)).toEqual(['StringEquals']);

      // The condition object is built at deploy time by CfnJson (its keys
      // contain the issuer URL), so read what CfnJson was given.
      const json = t.template.findResources('Custom::AWSCDKCfnJson');
      expect(Object.keys(json)).toHaveLength(1);
      const value = JSON.parse(flat(Object.values(json)[0].Properties.Value) as string);
      expect(value).toEqual({
        '<oidc-issuer>:aud': 'sts.amazonaws.com',
        '<oidc-issuer>:sub': 'system:serviceaccount:kube-system:aws-load-balancer-controller',
      });
    });

    it('publishes the role ARN as a stack output for the install step', () => {
      t.template.hasOutput('LoadBalancerControllerRoleArn', {});
    });
  });

  describe('what the role may do', () => {
    it('allows exactly these actions (adding one must change this test)', () => {
      const all = t.statements.flatMap(actionsOf);
      expect([...new Set(all)].sort()).toEqual([
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:CreateSecurityGroup',
        'ec2:CreateTags',
        'ec2:DeleteSecurityGroup',
        'ec2:DeleteTags',
        'ec2:DescribeAccountAttributes',
        'ec2:DescribeAddresses',
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeCoipPools',
        'ec2:DescribeInstances',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeIpamPools',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeRouteTables',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSubnets',
        'ec2:DescribeTags',
        'ec2:DescribeVpcPeeringConnections',
        'ec2:DescribeVpcs',
        'ec2:GetCoipPoolUsage',
        'ec2:GetSecurityGroupsForVpc',
        'ec2:RevokeSecurityGroupIngress',
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DescribeCapacityReservation',
        'elasticloadbalancing:DescribeListenerAttributes',
        'elasticloadbalancing:DescribeListenerCertificates',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:DescribeSSLPolicies',
        'elasticloadbalancing:DescribeTags',
        'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:DescribeTrustStores',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:ModifyListenerAttributes',
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:RemoveTags',
        'elasticloadbalancing:SetIpAddressType',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
        'iam:CreateServiceLinkedRole',
      ]);
    });

    it('is a subset of the published policy (catches a misspelt action, which IAM accepts silently)', () => {
      const raw = readFileSync(UPSTREAM_FILE);
      // The fixture must be the published file, byte for byte.
      expect(createHash('sha256').update(raw).digest('hex')).toBe(UPSTREAM_SHA256);

      const upstream = new Set(
        (JSON.parse(raw.toString()).Statement as Statement[]).flatMap(actionsOf),
      );
      const unknown = t.statements.flatMap(actionsOf).filter((a) => !upstream.has(a));
      expect(unknown).toEqual([]);
    });

    it('leaves out everything that is not needed for an NLB', () => {
      const all = t.statements.flatMap(actionsOf);
      for (const a of all) {
        expect(a).not.toMatch(/^(waf-regional|wafv2|shield|cognito-idp|acm):/);
      }
      // Listener rules, web ACLs, listener certificates, reserved capacity
      // and IP pools: reading them is harmless (the controller describes
      // them anyway); changing them is not allowed.
      const writes = all.filter((a) => !isRead(a));
      for (const a of writes) {
        expect(a).not.toMatch(/Rule|WebAcl|Certificates|CapacityReservation|IpPools/);
      }
      expect(JSON.stringify(t.statements)).not.toContain('/app/');
      expect(all.filter((a) => a.startsWith('iam:'))).toEqual(['iam:CreateServiceLinkedRole']);
    });

    it('only allows; there is no Deny to reason about and no NotAction/NotResource', () => {
      for (const s of t.statements) {
        expect(s.Effect).toBe('Allow');
        expect(Object.keys(s).sort()).toEqual(
          expect.arrayContaining(['Action', 'Effect', 'Resource', 'Sid']),
        );
        expect(Object.keys(s)).not.toContain('NotAction');
        expect(Object.keys(s)).not.toContain('NotResource');
      }
    });
  });

  describe('where the role may do it', () => {
    it('uses `Resource: "*"` in one statement only, and that one is read-only and region-bound', () => {
      const star = t.statements.filter((s) => resourcesOf(s).includes('*'));
      expect(star.map((s) => s.Sid)).toEqual(['ReadInRegion']);
      expect(actionsOf(star[0]).filter((a) => !isRead(a))).toEqual([]);
      expect(star[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': REGION } });
    });

    it('keeps every read action in that one statement', () => {
      const elsewhere = t.statements
        .filter((s) => s.Sid !== 'ReadInRegion')
        .flatMap(actionsOf)
        .filter(isRead);
      expect(elsewhere).toEqual([]);
    });

    it('names this region and this account in every other resource', () => {
      for (const s of t.statements.filter((x) => x.Sid !== 'ReadInRegion')) {
        for (const r of resourcesOf(s)) {
          expect(r).toMatch(
            new RegExp(`^arn:<partition>:(ec2|elasticloadbalancing):${REGION}:${ACCOUNT}:|^arn:<partition>:iam::${ACCOUNT}:role/`),
          );
        }
      }
    });

    it('binds every write to the project VPC, to this cluster\'s tag, or to one exact ARN', () => {
      // The whole policy apart from the read statement, written out.
      const writes = Object.fromEntries(
        t.statements
          .filter((s) => s.Sid !== 'ReadInRegion')
          .map((s) => [s.Sid, { resources: resourcesOf(s), condition: s.Condition }]),
      );
      expect(writes).toEqual({
        CreateElbServiceLinkedRole: {
          resources: [
            `arn:<partition>:iam::${ACCOUNT}:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing`,
          ],
          condition: { StringEquals: { 'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com' } },
        },
        CreateSecurityGroupInProjectVpc: { resources: [SG, VPC], condition: undefined },
        TagSecurityGroupOnCreate: {
          resources: [SG],
          condition: { StringEquals: { 'ec2:CreateAction': 'CreateSecurityGroup', [`aws:RequestTag/${TAG}`]: 'idp' } },
        },
        RetagOwnSecurityGroups: {
          resources: [SG],
          condition: {
            StringEquals: { [`aws:ResourceTag/${TAG}`]: 'idp' },
            Null: { [`aws:RequestTag/${TAG}`]: 'true' },
          },
        },
        SecurityGroupRulesInProjectVpc: { resources: [SG], condition: { ArnEquals: { 'ec2:Vpc': VPC } } },
        DeleteOwnSecurityGroups: {
          resources: [SG],
          condition: { StringEquals: { [`aws:ResourceTag/${TAG}`]: 'idp' } },
        },
        CreateNlbTaggedForThisCluster: {
          resources: [NLB, TG],
          condition: { StringEquals: { [`aws:RequestTag/${TAG}`]: 'idp' } },
        },
        TagNlbOnCreate: {
          resources: [NLB, TG],
          condition: {
            StringEquals: {
              'elasticloadbalancing:CreateAction': ['CreateLoadBalancer', 'CreateTargetGroup'],
              [`aws:RequestTag/${TAG}`]: 'idp',
            },
          },
        },
        TagListenerOnCreate: {
          resources: [LISTENER],
          condition: { StringEquals: { [`aws:RequestTag/${TAG}`]: 'idp' } },
        },
        RetagOwnElbResources: {
          resources: [NLB, TG, LISTENER],
          condition: {
            StringEquals: { [`aws:ResourceTag/${TAG}`]: 'idp' },
            Null: { [`aws:RequestTag/${TAG}`]: 'true' },
          },
        },
        ManageOwnElbResources: {
          resources: [NLB, TG, LISTENER],
          condition: { StringEquals: { [`aws:ResourceTag/${TAG}`]: 'idp' } },
        },
      });
    });

    it('can create a security group only in the project VPC (the one unconditioned write)', () => {
      const s = bySid('CreateSecurityGroupInProjectVpc');
      expect(actionsOf(s)).toEqual(['ec2:CreateSecurityGroup']);
      // AWS checks the action against the group and the VPC. With one
      // exact VPC ARN and no wildcard VPC, any other VPC is denied.
      expect(resourcesOf(s).filter((r) => r.includes(':vpc/'))).toEqual([VPC]);
    });

    it('can never move or remove the cluster tag on something that exists', () => {
      const retag = t.statements.filter((s) =>
        actionsOf(s).some((a) => /:(DeleteTags|RemoveTags)$/.test(a)));
      expect(retag.map((s) => s.Sid).sort()).toEqual(['RetagOwnElbResources', 'RetagOwnSecurityGroups']);
      for (const s of retag) {
        expect(s.Condition?.Null).toEqual({ [`aws:RequestTag/${TAG}`]: 'true' });
      }
    });

    it('follows the cluster name: another cluster\'s role cannot touch this one\'s load balancers', () => {
      const other = synth('other');
      const text = JSON.stringify(other.statements);
      expect(text).toContain(`"aws:ResourceTag/${TAG}":"other"`);
      expect(text).not.toContain(`"aws:ResourceTag/${TAG}":"idp"`);
      expect(text).not.toContain(`"aws:RequestTag/${TAG}":"idp"`);
    });
  });
});

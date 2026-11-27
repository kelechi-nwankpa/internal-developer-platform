import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { ClusterStack } from '../lib/cluster-stack';

/**
 * Tests for cert-manager's IAM role (ADR-0038).
 *
 * The role's whole value is what it cannot do: change any record except
 * a certificate challenge in our own zone. A loosened condition would
 * still work in a session, so nothing but these tests would notice.
 * The policy is pinned in full.
 */

const ACCOUNT = '123456789012';
const REGION = 'eu-west-1';
const ZONE = 'idp.example.com';

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

/** Turns CloudFormation intrinsics into readable text. */
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
    if (k === 'Fn::ImportValue') return /HarnessZone/.test(JSON.stringify(o[k])) ? '<project-zone-id>' : '<import>';
    if (k === 'Fn::GetAtt') return `<attr:${(o[k] as string[]).join('.')}>`;
    if (k === 'Fn::Select' || k === 'Fn::Split') return '<oidc-issuer>';
  }
  return Object.fromEntries(keys.map((k) => [k, flat(o[k])]));
}

function synth(zoneName = ZONE) {
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
    hostedZone: new route53.PublicHostedZone(scaffold, 'HarnessZone', { zoneName }),
    zoneName,
  });
  const template = Template.fromStack(stack);

  const roles = template.findResources('AWS::IAM::Role', {
    Properties: { Description: cdk.assertions.Match.stringLikeRegexp('^cert-manager ') },
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

const ZONE_ARN = 'arn:<partition>:route53:::hostedzone/<project-zone-id>';

describe('CertManagerRole', () => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    t = synth();
  });
  const bySid = (sid: string) => t.statements.find((s) => s.Sid === sid) as Statement;

  test('there is one role with one inline policy and no managed policies', () => {
    expect(t.roleCount).toBe(1);
    expect(t.policyCount).toBe(1);
    expect(t.role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  test('the role has no fixed name (a fixed idp- name would match the teardown sweep)', () => {
    expect(t.role.Properties.RoleName).toBeUndefined();
  });

  test('only the cert-manager controller ServiceAccount can assume it', () => {
    const trust = t.role.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(Object.keys(trust[0].Condition)).toEqual(['StringEquals']);

    // The stack has one CfnJson per IRSA role; take the one this role's
    // trust policy points at.
    const [jsonId] = trust[0].Condition.StringEquals['Fn::GetAtt'] as string[];
    const json = t.template.findResources('Custom::AWSCDKCfnJson');
    expect(JSON.parse(flat(json[jsonId].Properties.Value) as string)).toEqual({
      '<oidc-issuer>:aud': 'sts.amazonaws.com',
      '<oidc-issuer>:sub': 'system:serviceaccount:cert-manager:cert-manager',
    });
  });

  test('the policy is exactly these four statements, all Allow', () => {
    expect(t.statements.map((s) => s.Sid).sort()).toEqual([
      'FindZoneByName',
      'ListRecordsInProjectZone',
      'ReadChangeStatus',
      'WriteAcmeChallengeRecords',
    ]);
    expect(t.statements.every((s) => s.Effect === 'Allow')).toBe(true);
  });

  test('the only write action in the whole policy is ChangeResourceRecordSets', () => {
    const actions = t.statements.flatMap((s) => ([] as string[]).concat(s.Action)).sort();
    expect(actions).toEqual([
      'route53:ChangeResourceRecordSets',
      'route53:GetChange',
      'route53:ListHostedZonesByName',
      'route53:ListResourceRecordSets',
    ]);
  });

  test('the write is limited to the project zone, TXT records and challenge names', () => {
    expect(bySid('WriteAcmeChallengeRecords')).toEqual({
      Sid: 'WriteAcmeChallengeRecords',
      Effect: 'Allow',
      Action: 'route53:ChangeResourceRecordSets',
      Resource: ZONE_ARN,
      Condition: {
        'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'] },
        'ForAllValues:StringLike': {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [
            `_acme-challenge.${ZONE}`,
            `_acme-challenge.*.${ZONE}`,
          ],
        },
      },
    });
  });

  test('no allowed record name could be an ordinary hostname', () => {
    const names = bySid('WriteAcmeChallengeRecords').Condition!['ForAllValues:StringLike'][
      'route53:ChangeResourceRecordSetsNormalizedRecordNames'
    ] as string[];
    for (const n of names) {
      expect(n.startsWith('_acme-challenge.')).toBe(true);
      expect(n.endsWith(`.${ZONE}`)).toBe(true);
    }
  });

  test('listing records is limited to the project zone', () => {
    expect(bySid('ListRecordsInProjectZone')).toEqual({
      Sid: 'ListRecordsInProjectZone',
      Effect: 'Allow',
      Action: 'route53:ListResourceRecordSets',
      Resource: ZONE_ARN,
    });
  });

  test('the two statements with a wildcard resource are read-only, one action each', () => {
    expect(bySid('FindZoneByName')).toEqual({
      Sid: 'FindZoneByName',
      Effect: 'Allow',
      Action: 'route53:ListHostedZonesByName',
      Resource: '*',
    });
    expect(bySid('ReadChangeStatus')).toEqual({
      Sid: 'ReadChangeStatus',
      Effect: 'Allow',
      Action: 'route53:GetChange',
      Resource: 'arn:aws:route53:::change/*',
    });
    const wild = t.statements.filter((s) => JSON.stringify(s.Resource).includes('*'));
    expect(wild.map((s) => s.Sid).sort()).toEqual(['FindZoneByName', 'ReadChangeStatus']);
  });

  test('the role ARN is a stack output for the bootstrap to read', () => {
    t.template.hasOutput('CertManagerRoleArn', {});
  });

  test('another zone name changes the allowed record names with it', () => {
    const other = synth('other.example.org');
    const s = other.statements.find((x) => x.Sid === 'WriteAcmeChallengeRecords') as Statement;
    expect(JSON.stringify(s.Condition)).toContain('_acme-challenge.other.example.org');
    expect(JSON.stringify(s.Condition)).not.toContain(ZONE);
  });
});

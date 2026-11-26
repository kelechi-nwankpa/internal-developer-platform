import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ClusterStack, FARGATE_NAMESPACES } from '../lib/cluster-stack';

/**
 * Helper — builds a synthesised ClusterStack Template.
 * We build the VPC and the KMS key in the same test app so the
 * cross-stack references resolve.
 *
 * Note: `Parameters<T>` extracts function parameter types. `ClusterStack`
 * is a class, so we use `ConstructorParameters<T>` — the equivalent
 * utility for extracting constructor arg types.
 */
type ClusterStackCtorProps = ConstructorParameters<typeof ClusterStack>[2];

function synthClusterStack(overrides: Partial<ClusterStackCtorProps> = {}) {
  const app = new cdk.App();

  // Minimal harness VPC + CMK so ClusterStack has real inputs.
  const scaffoldStack = new cdk.Stack(app, 'ScaffoldStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
  });
  const vpc = new ec2.Vpc(scaffoldStack, 'HarnessVpc', {
    maxAzs: 3,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'pub', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'p', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
    ],
  });
  const eksSecretsKey = new kms.Key(scaffoldStack, 'HarnessKey');

  const stack = new ClusterStack(app, 'TestClusterStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
    vpc,
    eksSecretsKey,
    ...overrides,
  });

  return { stack, template: Template.fromStack(stack), vpcTemplate: Template.fromStack(scaffoldStack) };
}

describe('ClusterStack', () => {
  let template: Template;
  let stack: ClusterStack;
  let vpcTemplate: Template;

  beforeAll(() => {
    ({ stack, template, vpcTemplate } = synthClusterStack());
  });

  // Cluster and Fargate profiles are wrapped in CDK's Lambda-backed custom
  // resource: `Custom::AWSCDK-EKS-Cluster` and `Custom::AWSCDK-EKS-FargateProfile`.
  // Their inputs live under `Properties.Config` in the SDK-shaped camelCase
  // (e.g., `name`, `version`, `resourcesVpcConfig`) rather than the
  // PascalCase you'd see on a native `AWS::EKS::Cluster`.
  it('creates exactly one EKS cluster named "idp"', () => {
    const clusters = template.findResources('Custom::AWSCDK-EKS-Cluster');
    expect(Object.keys(clusters)).toHaveLength(1);
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        name: 'idp',
      }),
    });
  });

  it('uses PUBLIC_AND_PRIVATE endpoint access', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        resourcesVpcConfig: Match.objectLike({
          endpointPublicAccess: true,
          endpointPrivateAccess: true,
        }),
      }),
    });
  });

  it('enables all five control-plane log types', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        logging: Match.objectLike({
          clusterLogging: Match.arrayWith([
            Match.objectLike({
              enabled: true,
              types: Match.arrayWith([
                'api',
                'audit',
                'authenticator',
                'controllerManager',
                'scheduler',
              ]),
            }),
          ]),
        }),
      }),
    });
  });

  it('enables Kubernetes secrets envelope encryption with a KMS key', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        encryptionConfig: Match.arrayWith([
          Match.objectLike({
            resources: Match.arrayWith(['secrets']),
          }),
        ]),
      }),
    });
  });

  describe('Fargate profiles', () => {
    // Every selector of every profile, straight from the template.
    const selectors = () =>
      Object.values(template.findResources('Custom::AWSCDK-EKS-FargateProfile')).map(
        (p) => p.Properties.Config.selectors as { namespace: string; labels?: object }[],
      );
    const namespaces = () => selectors().flat().map((s) => s.namespace);

    it('creates exactly three profiles (each one adds minutes to a billed deploy)', () => {
      expect(selectors()).toHaveLength(3);
    });

    it('allows pods in exactly the namespaces of the EKS slice, no more', () => {
      // Written out by hand, not read from FARGATE_NAMESPACES: adding a
      // namespace that can run billable pods must change this test too.
      expect(namespaces().sort()).toEqual([
        'argocd',
        'cert-manager',
        'crossplane-system',
        'envoy-gateway-system',
        'external-dns',
        'gateway',
        'kube-system',
        'platform-hello',
      ]);
    });

    it('lists no namespace twice (two matching profiles is ambiguous)', () => {
      expect(new Set(namespaces()).size).toBe(namespaces().length);
    });

    it('uses no wildcard: an unlisted namespace must not be able to run pods', () => {
      for (const ns of namespaces()) {
        expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
      }
    });

    it('does not open the `default` namespace', () => {
      expect(namespaces()).not.toContain('default');
    });

    it('keeps every profile within the EKS limit of five selectors', () => {
      for (const s of selectors()) {
        expect(s.length).toBeGreaterThan(0);
        expect(s.length).toBeLessThanOrEqual(5);
      }
    });

    it('selects whole namespaces, not labelled pods (a missing label would strand a pod)', () => {
      for (const s of selectors().flat()) {
        expect(s.labels).toBeUndefined();
      }
    });

    it('creates the profiles one after another (EKS refuses two at once)', () => {
      const profiles = template.findResources('Custom::AWSCDK-EKS-FargateProfile');
      const ids = Object.keys(profiles);
      const waitsOnAnother = ids.filter((id) =>
        ([] as string[]).concat(profiles[id].DependsOn ?? []).some((d) => ids.includes(d)));
      expect(waitsOnAnother).toHaveLength(ids.length - 1);
    });

    it('exports the same list the template uses', () => {
      const exported = Object.values(FARGATE_NAMESPACES).flat().sort();
      expect(namespaces().sort()).toEqual(exported);
    });
  });

  // The AWS Load Balancer Controller picks subnets for an internet-facing
  // NLB by this tag. The EKS construct adds it to the VPC's subnets; no
  // line of ours does. If a CDK upgrade stopped doing that, the Gateway
  // would get no load balancer and nothing else would fail first.
  it('tags public subnets for internet-facing load balancers, private ones for internal', () => {
    const subnets = Object.values(vpcTemplate.findResources('AWS::EC2::Subnet'));
    const tagsOf = (r: { [key: string]: any }): Record<string, string> =>
      Object.fromEntries(((r.Properties.Tags ?? []) as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value]));
    const pub = subnets.filter((r) => tagsOf(r)['aws-cdk:subnet-type'] === 'Public');
    const priv = subnets.filter((r) => tagsOf(r)['aws-cdk:subnet-type'] === 'Private');
    expect(pub).toHaveLength(3);
    expect(priv).toHaveLength(3);
    for (const r of pub) {
      expect(tagsOf(r)['kubernetes.io/role/elb']).toBe('1');
      expect(tagsOf(r)['kubernetes.io/role/internal-elb']).toBeUndefined();
    }
    for (const r of priv) {
      expect(tagsOf(r)['kubernetes.io/role/internal-elb']).toBe('1');
      expect(tagsOf(r)['kubernetes.io/role/elb']).toBeUndefined();
    }
  });

  it('provisions zero node groups (Fargate-only — ADR-0010)', () => {
    // Neither the native CFN type nor CDK's custom-resource wrapper exists.
    template.resourceCountIs('AWS::EKS::Nodegroup', 0);
    template.resourceCountIs('Custom::AWSCDK-EKS-Nodegroup', 0);
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 0);
  });

  it('exposes cluster and clusterAdminRole as public stack members', () => {
    expect(stack.cluster).toBeDefined();
    expect(stack.clusterAdminRole).toBeDefined();
  });

  it('emits CloudFormation outputs for cluster name, admin role, and IRSA OIDC ARN', () => {
    template.hasOutput('ClusterName', {});
    template.hasOutput('ClusterAdminRoleArn', {});
    template.hasOutput('OidcProviderArn', {});
  });

  it('respects a custom Kubernetes version', () => {
    const { template: v30 } = synthClusterStack({
      kubernetesVersion: KubernetesVersion.V1_30,
    });
    v30.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        version: '1.30',
      }),
    });
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

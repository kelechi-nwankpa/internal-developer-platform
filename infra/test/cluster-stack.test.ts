import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ClusterStack } from '../lib/cluster-stack';

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
    natGateways: 0,
    subnetConfiguration: [
      { name: 'p', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
    ],
  });
  const eksSecretsKey = new kms.Key(scaffoldStack, 'HarnessKey');

  const stack = new ClusterStack(app, 'TestClusterStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
    vpc,
    eksSecretsKey,
    ...overrides,
  });

  return { stack, template: Template.fromStack(stack) };
}

describe('ClusterStack', () => {
  let template: Template;
  let stack: ClusterStack;

  beforeAll(() => {
    ({ stack, template } = synthClusterStack());
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

  it('creates exactly two Fargate profiles (kube-system, default)', () => {
    const profiles = template.findResources('Custom::AWSCDK-EKS-FargateProfile');
    expect(Object.keys(profiles)).toHaveLength(2);
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

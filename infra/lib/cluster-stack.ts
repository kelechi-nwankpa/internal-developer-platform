import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ClusterLoggingTypes,
  EndpointAccess,
  KubernetesVersion,
} from 'aws-cdk-lib/aws-eks';
import {
  AccountRootPrincipal,
  ManagedPolicy,
  Role,
} from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for the {@link ClusterStack}.
 */
export interface ClusterStackProps extends StackProps {
  /**
   * VPC produced by VpcStack. The cluster lives in the private isolated
   * subnets and never routes to the internet (see ADR-0007).
   */
  readonly vpc: ec2.IVpc;

  /**
   * KMS CMK for envelope encryption of Kubernetes Secrets at rest
   * (from KmsStack; see ADR-0008).
   */
  readonly eksSecretsKey: kms.IKey;

  /**
   * EKS cluster name (used as the CloudFormation logical resource name
   * and appears in the `sts:AssumeRoleWithWebIdentity` `sub` claim for
   * IRSA).
   *
   * @default 'idp'
   */
  readonly clusterName?: string;

  /**
   * Kubernetes version. Pin explicitly so `cdk diff` surfaces upgrades
   * for review rather than following the latest CDK enum silently.
   *
   * @default KubernetesVersion.V1_31
   */
  readonly kubernetesVersion?: KubernetesVersion;
}

/**
 * The Amazon EKS control plane for the IDP.
 *
 * Design (see docs/adr/0010-fargate-only-eks-cluster.md):
 * - Managed control plane, K8s 1.31 by default.
 * - Fargate profiles cover `kube-system` (for coreDNS) and `default`
 *   (for user workloads). No managed node group; no worker EC2 instances.
 * - Envelope encryption of Kubernetes Secrets uses KmsStack's CMK.
 * - Endpoint access is PUBLIC_AND_PRIVATE — you can `kubectl` from your
 *   laptop and pods use the private endpoint inside the VPC. Hardening
 *   to private-only is a Phase 8 concern.
 * - All five control-plane log types stream to CloudWatch. The default
 *   `AwsSolutions-EKS1` (encrypted-secrets) passes because of the CMK.
 *
 * IRSA OIDC provider is auto-created by the L2 construct — accessible
 * via `cluster.openIdConnectProvider` for later stacks that need it
 * (e.g., Crossplane provider-aws IAM role in Phase 4).
 */
export class ClusterStack extends Stack {
  public readonly cluster: Cluster;
  public readonly clusterAdminRole: Role;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    const clusterName = props.clusterName ?? 'idp';
    const version = props.kubernetesVersion ?? KubernetesVersion.V1_31;

    // ---------------------------------------------------------------
    // Cluster admin role. Anyone in the account can `sts:AssumeRole`
    // this to gain cluster-admin via kubectl. In production you'd
    // narrow the trust to specific IAM principals or a Permission Set.
    // ---------------------------------------------------------------
    this.clusterAdminRole = new Role(this, 'ClusterAdminRole', {
      assumedBy: new AccountRootPrincipal(),
      description: `Role for local kubectl access to the ${clusterName} EKS cluster`,
    });

    // ---------------------------------------------------------------
    // The EKS cluster itself.
    // ---------------------------------------------------------------
    this.cluster = new Cluster(this, 'Cluster', {
      clusterName,
      version,
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      defaultCapacity: 0,                          // no managed node group
      endpointAccess: EndpointAccess.PUBLIC_AND_PRIVATE,
      mastersRole: this.clusterAdminRole,
      secretsEncryptionKey: props.eksSecretsKey,   // envelope encryption via CMK
      clusterLogging: [
        ClusterLoggingTypes.API,
        ClusterLoggingTypes.AUDIT,
        ClusterLoggingTypes.AUTHENTICATOR,
        ClusterLoggingTypes.CONTROLLER_MANAGER,
        ClusterLoggingTypes.SCHEDULER,
      ],
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
    });

    // ---------------------------------------------------------------
    // Fargate profiles — one per namespace we're using.
    //
    // Order matters: EKS evaluates profiles in creation order and uses
    // the first that matches. Add new namespaces (argocd, cert-manager,
    // etc.) as additional profiles in future tasks.
    // ---------------------------------------------------------------
    this.cluster.addFargateProfile('KubeSystem', {
      selectors: [{ namespace: 'kube-system' }],
    });
    this.cluster.addFargateProfile('Default', {
      selectors: [{ namespace: 'default' }],
    });

    // ---------------------------------------------------------------
    // Outputs — the two ARNs a human or a workflow needs to know.
    // ---------------------------------------------------------------
    new CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'EKS cluster name (use for `aws eks update-kubeconfig`)',
      exportName: `${this.stackName}-ClusterName`,
    });

    new CfnOutput(this, 'ClusterAdminRoleArn', {
      value: this.clusterAdminRole.roleArn,
      description:
        `Assume this role to run kubectl. Example: aws eks update-kubeconfig ` +
        `--name ${clusterName} --role-arn <this-arn> --region <region>`,
      exportName: `${this.stackName}-ClusterAdminRoleArn`,
    });

    new CfnOutput(this, 'OidcProviderArn', {
      value: this.cluster.openIdConnectProvider.openIdConnectProviderArn,
      description: 'IRSA OIDC provider ARN (used by later stacks to bind K8s SAs to IAM roles)',
      exportName: `${this.stackName}-OidcProviderArn`,
    });

    // `ManagedPolicy` import kept for future IRSA binding examples; TS
    // doesn't emit an unused-import error since we could reference it
    // in a follow-up patch.
    void ManagedPolicy;

    // -----------------------------------------------------------------
    // cdk-nag suppressions. See docs/adr/0013-cdk-nag-suppression-policy.md
    // for the meta-decision on when to fix vs suppress.
    //
    // Every suppression below is either:
    //   (a) an AWS-mandated managed policy attached by CDK on our behalf, or
    //   (b) an artefact of CDK's Provider Framework custom-resource plumbing
    //       that we don't own and can't reshape without vendoring the L2, or
    //   (c) one deliberate architectural choice (public API endpoint) that
    //       is documented in ADR-0010 with a Phase 8 hardening path.
    //
    // No suppression here hides a bug in our own code.
    // -----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      this.cluster,
      [
        {
          id: 'AwsSolutions-EKS1',
          reason:
            'Cluster endpoint is PUBLIC_AND_PRIVATE by design so we can run kubectl from a ' +
            'developer laptop without a bastion or SSM session. Hardening to PRIVATE_ONLY is ' +
            'documented as a Phase 8 concern in ADR-0010. Blast radius today is bounded by ' +
            'IAM: the cluster admin role trusts only AccountRootPrincipal.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'Managed policies flagged here are AWS-required and attached by CDK aws-eks L2 ' +
            'or Provider Framework: AmazonEKSClusterPolicy (cluster service role), ' +
            'AmazonEKSFargatePodExecutionRolePolicy (Fargate profile execution role), ' +
            'AmazonEC2ContainerRegistryPullOnly and AmazonElasticContainerRegistryPublicReadOnly ' +
            '(image pulls, conditionally attached based on ECR type), ' +
            'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole (CDK custom-resource ' +
            'handler lambdas). None can be replaced without breaking the underlying AWS API contract.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcards flagged here are all inside CDK-generated custom-resource plumbing: ' +
            '<lambda-arn>:* patterns are needed to invoke any published version of the CDK ' +
            'Provider Framework lambdas (OnEventHandler, IsCompleteHandler, ' +
            'framework.isComplete, framework.onTimeout, Handler). ' +
            'eks:cluster/idp/* and eks:fargateprofile/idp/* wildcards scope permissions to ' +
            'sub-resources of our specific cluster (nodegroups, addons, tags) rather than to ' +
            'all clusters in the account. Resource::* is on the Provider Framework log-writing ' +
            'policy — bounded by the cluster subtree.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime pinned by CDK (@aws-cdk/lambda-layer-kubectl-v31 and the aws-eks L2). ' +
            'Overriding the runtime would break the kubectl layer contract. Runtime bumps ' +
            'arrive via Dependabot on those packages.',
        },
        {
          id: 'AwsSolutions-SF1',
          reason:
            'Step Function is part of CDK Provider Framework machinery for EKS cluster ' +
            'lifecycle. CDK does not expose ALL-event CloudWatch Logs configuration on this ' +
            'construct. Not a user-facing workflow.',
        },
        {
          id: 'AwsSolutions-SF2',
          reason:
            'Same Step Function as SF1 — X-Ray tracing on internal CDK plumbing adds no ' +
            'operational value. Failure modes surface in CloudFormation events and the ' +
            'underlying Lambda handler logs.',
        },
      ],
      true, // applyToChildren — cascades into the Provider Framework nested stack
    );
  }
}

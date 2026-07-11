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
  }
}

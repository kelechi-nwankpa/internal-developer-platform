import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ClusterLoggingTypes,
  CoreDnsComputeType,
  EndpointAccess,
  KubernetesVersion,
} from 'aws-cdk-lib/aws-eks';
import {
  AccountRootPrincipal,
  ManagedPolicy,
  Role,
} from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { KubectlV36Layer } from '@aws-cdk/lambda-layer-kubectl-v36';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { LoadBalancerControllerRole } from './load-balancer-controller-role';

/**
 * Namespaces whose pods may run on this cluster, grouped into Fargate
 * profiles. A Fargate-only cluster has no nodes: a pod runs only if a
 * profile names its namespace. Anything else stays Pending for ever,
 * with the event "no nodes available to schedule pods".
 *
 * This list is the EKS slice of the platform (Phase 9): enough to serve
 * one golden-path service over HTTPS with a bucket. Backstage, Vault and
 * the monitoring stack are not here on purpose: they need volumes and
 * DaemonSets, which Fargate does not offer (ADR-0010).
 *
 * Why three profiles and not one per namespace: EKS creates profiles one
 * at a time, a few minutes each, while the control plane is already
 * billing. Why not one profile: a profile holds at most five selectors.
 *
 * Why no wildcard (`*`): it would be simpler, and every new service
 * would just work. But then any namespace anyone creates can start
 * billable pods. An explicit list is deny-by-default; the price is that
 * a new service needs a line here and a redeploy of the profile.
 */
export const FARGATE_NAMESPACES = {
  /** CoreDNS and the AWS Load Balancer Controller. */
  system: ['kube-system'],
  /** Controllers that make up the platform slice. */
  platform: ['argocd', 'cert-manager', 'crossplane-system', 'envoy-gateway-system', 'external-dns'],
  /** The shared edge proxy, and the services behind it. */
  workloads: ['gateway', 'platform-hello'],
} as const;

/**
 * Properties for the {@link ClusterStack}.
 */
export interface ClusterStackProps extends StackProps {
  /**
   * VPC produced by VpcStack. The cluster lives in the private subnets,
   * which reach the internet only outbound, through one NAT Gateway
   * (see ADR-0035).
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
   * MUST be a version in EKS *standard* support. Extended support adds
   * $0.50/h on top of the $0.10/h control plane: Phase 1 ran 1.31 after
   * its standard support had ended and that surcharge was 43% of the
   * bill (docs/COST.md incident log). 1.36 matches the kind cluster
   * (v1.36.x) and is in standard support until 2027-08-02. Re-check with
   * `aws eks describe-cluster-versions` before every deploy.
   *
   * @default KubernetesVersion.V1_36
   */
  readonly kubernetesVersion?: KubernetesVersion;
}

/**
 * The Amazon EKS control plane for the IDP.
 *
 * Design (see docs/adr/0010-fargate-only-eks-cluster.md):
 * - Managed control plane, K8s 1.36 by default (same minor as kind).
 * - Fargate profiles cover exactly the namespaces in
 *   FARGATE_NAMESPACES. No managed node group; no worker EC2 instances.
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
    const version = props.kubernetesVersion ?? KubernetesVersion.V1_36;

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
      // Private subnets with a route to the NAT (ADR-0035). Fargate pods
      // may only run in private subnets, and the platform's pods need the
      // internet (GitHub, ghcr.io, cgr.dev, Let's Encrypt).
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,                          // no managed node group
      endpointAccess: EndpointAccess.PUBLIC_AND_PRIVATE,
      mastersRole: this.clusterAdminRole,
      secretsEncryptionKey: props.eksSecretsKey,   // envelope encryption via CMK
      // Without this, EKS ships coredns with an `eks.amazonaws.com/compute-type: ec2`
      // annotation that prevents scheduling on Fargate. In a Fargate-only cluster
      // that annotation deadlocks the pods forever. `CoreDnsComputeType.FARGATE`
      // tells CDK to patch the annotation as part of cluster provisioning.
      // See ADR-0010 postscript.
      coreDnsComputeType: CoreDnsComputeType.FARGATE,
      clusterLogging: [
        ClusterLoggingTypes.API,
        ClusterLoggingTypes.AUDIT,
        ClusterLoggingTypes.AUTHENTICATOR,
        ClusterLoggingTypes.CONTROLLER_MANAGER,
        ClusterLoggingTypes.SCHEDULER,
      ],
      kubectlLayer: new KubectlV36Layer(this, 'KubectlLayer'),
    });

    // ---------------------------------------------------------------
    // Fargate profiles — see FARGATE_NAMESPACES for what and why.
    //
    // No namespace may appear in two profiles: when two profiles match a
    // pod, EKS picks one by profile name, which is easy to get wrong and
    // hard to see. The unit tests assert there is no overlap.
    //
    // Profiles cannot be edited in place. Changing a list replaces that
    // profile, and pods already running under it keep running until they
    // are restarted.
    // ---------------------------------------------------------------
    this.cluster.addFargateProfile('KubeSystem', {
      selectors: FARGATE_NAMESPACES.system.map((namespace) => ({ namespace })),
    });
    this.cluster.addFargateProfile('Platform', {
      selectors: FARGATE_NAMESPACES.platform.map((namespace) => ({ namespace })),
    });
    this.cluster.addFargateProfile('Workloads', {
      selectors: FARGATE_NAMESPACES.workloads.map((namespace) => ({ namespace })),
    });

    // ---------------------------------------------------------------
    // IAM role for the AWS Load Balancer Controller (ADR-0036). It lives
    // in this stack because its trust policy names this cluster's OIDC
    // provider, and because it must be deleted with the cluster.
    // ---------------------------------------------------------------
    const lbController = new LoadBalancerControllerRole(this, 'LoadBalancerController', {
      cluster: this.cluster,
      clusterName,
      vpc: props.vpc,
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

    new CfnOutput(this, 'LoadBalancerControllerRoleArn', {
      value: lbController.role.roleArn,
      description:
        'IAM role for the AWS Load Balancer Controller. Goes on its ServiceAccount as the ' +
        'eks.amazonaws.com/role-arn annotation.',
      exportName: `${this.stackName}-LoadBalancerControllerRoleArn`,
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
    //
    // We use `addStackSuppressions` with `applyToNestedStacks: true` because
    // CDK's aws-eks L2 creates a separate nested stack for the Provider
    // Framework Lambda handlers + Step Function. `addResourceSuppressions`
    // with `applyToChildren: true` does NOT cross nested-stack boundaries.
    // -----------------------------------------------------------------
    NagSuppressions.addStackSuppressions(
      this,
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
          // Narrowed on 2026-11-26 (owner approved, ADR-0036). This used
          // to have no `appliesTo`, so it hid every wildcard in the stack,
          // including ones in our own roles. Now it matches only the
          // three shapes CDK's own plumbing produces; anything else fails
          // the build.
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK-generated custom-resource plumbing only. <lambda-arn>:* lets the Provider ' +
            'Framework invoke any published version of its own handler lambdas (OnEventHandler, ' +
            'IsCompleteHandler, framework.isComplete, framework.onTimeout, Handler). ' +
            'eks:cluster/idp/* and eks:fargateprofile/idp/* are sub-resources of this one ' +
            'named cluster (addons, tags, profiles), not all clusters in the account.',
          appliesTo: [
            { regex: '/^Resource::<[A-Za-z0-9]+\\.Arn>:\\*$/g' },
            { regex: `/^Resource::arn:<AWS::Partition>:eks:[a-z0-9-]+:[^:]+:cluster\\/${clusterName}\\/\\*$/g` },
            { regex: `/^Resource::arn:<AWS::Partition>:eks:[a-z0-9-]+:[^:]+:fargateprofile\\/${clusterName}\\/\\*$/g` },
          ],
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime pinned by CDK (@aws-cdk/lambda-layer-kubectl-v36 and the aws-eks L2). ' +
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
      true, // applyToNestedStacks — cascades into the Provider Framework nested stack
    );

    // The role CDK uses to create the cluster. CDK writes its policy; it
    // has `Resource: "*"` on Describe calls (AWS allows nothing narrower),
    // on iam:GetRole/listAttachedRolePolicies, and on
    // iam:CreateServiceLinkedRole. Scoped to this one policy so a bare
    // `*` anywhere else in the stack is still an error.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.node.path}/Cluster/Resource/CreationRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Policy generated by the CDK aws-eks construct for the role that creates the ' +
            'cluster. We cannot reshape it without vendoring the construct. The role is used ' +
            'only by CDK custom-resource lambdas during deploy. Approved 2026-11-26.',
          appliesTo: ['Resource::*'],
        },
      ],
    );
  }
}

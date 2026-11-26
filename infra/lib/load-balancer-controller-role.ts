import { CfnJson, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ICluster } from 'aws-cdk-lib/aws-eks';
import { Effect, FederatedPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Where the AWS Load Balancer Controller runs in the cluster. The role
 * below can be used by this one ServiceAccount and nothing else, so the
 * Helm install (platform/) must use exactly these two names.
 */
export const LB_CONTROLLER_NAMESPACE = 'kube-system';
export const LB_CONTROLLER_SERVICE_ACCOUNT = 'aws-load-balancer-controller';

/**
 * The tag the controller puts on everything it creates (load balancer,
 * target group, listener, security group). Its value is the cluster
 * name. Checked in the controller's source at v3.6.3
 * (pkg/shared_constants/tag_keys.go, pkg/deploy/tracking/provider.go).
 */
export const LB_CONTROLLER_CLUSTER_TAG = 'elbv2.k8s.aws/cluster';

export interface LoadBalancerControllerRoleProps {
  /** The cluster whose OIDC provider signs the ServiceAccount's token. */
  readonly cluster: ICluster;

  /**
   * The cluster name as plain text. The controller is installed with the
   * same name and writes it as the value of LB_CONTROLLER_CLUSTER_TAG.
   */
  readonly clusterName: string;

  /** The project VPC. Security-group changes are limited to it. */
  readonly vpc: ec2.IVpc;
}

/**
 * IAM role for the AWS Load Balancer Controller (ADR-0036).
 *
 * The controller creates the network load balancer (NLB) that carries
 * internet traffic to the Envoy proxy pod. To do that it calls AWS, so
 * it needs AWS permissions.
 *
 * This is NOT the policy the controller's project publishes. That policy
 * allows several write actions on every resource in the account, which
 * CLAUDE.md forbids and which would reach the owner's other projects in
 * this shared account. This one is trimmed and tightened:
 *
 *  - NLB only. Everything for application load balancers, WAF, Shield,
 *    Cognito and certificates is left out.
 *  - Every write is limited to this region and account, and then to one
 *    of: the project VPC, or resources tagged for this cluster.
 *  - Only read-only actions keep `Resource: "*"`; AWS does not let
 *    Describe calls be narrowed.
 *
 * The price: if an action the controller needs is missing, the NLB is
 * not created and the controller logs "AccessDenied" with the action
 * name. test/load-balancer-controller-role.test.ts pins the exact list
 * so a change here is always a deliberate one.
 *
 * The role is trusted through IRSA (a ServiceAccount token exchanged for
 * AWS credentials). EKS Pod Identity is the newer way, but it needs an
 * agent on a node and Fargate has no nodes.
 *
 * The ServiceAccount itself is not created here. `cluster.addServiceAccount`
 * would do both in one call, but it would have CDK write into the
 * cluster, and in this project only ArgoCD does that (GitOps-first).
 */
export class LoadBalancerControllerRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: LoadBalancerControllerRoleProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const provider = props.cluster.openIdConnectProvider;
    const issuer = provider.openIdConnectProviderIssuer;

    // The issuer URL is only known at deploy time, and it is part of the
    // condition *keys*. CloudFormation cannot compute a key, so CfnJson
    // builds the object at deploy time.
    const trustConditions = new CfnJson(this, 'TrustConditions', {
      value: {
        // Token was issued for AWS STS, not for some other audience.
        [`${issuer}:aud`]: 'sts.amazonaws.com',
        // Token belongs to exactly this ServiceAccount. Without this
        // line every pod in the cluster could use the role.
        [`${issuer}:sub`]: `system:serviceaccount:${LB_CONTROLLER_NAMESPACE}:${LB_CONTROLLER_SERVICE_ACCOUNT}`,
      },
    });

    // No roleName: CloudFormation picks one. A fixed `idp-` name would
    // also match the teardown sweep (scripts/aws-down.sh), and two things
    // deleting one role is one too many. The ARN is a stack output.
    this.role = new Role(this, 'Role', {
      description: `AWS Load Balancer Controller on the ${props.clusterName} EKS cluster (ADR-0036)`,
      assumedBy: new FederatedPrincipal(
        provider.openIdConnectProviderArn,
        { StringEquals: trustConditions },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    const arn = (service: string, resource: string) =>
      `arn:${stack.partition}:${service}:${stack.region}:${stack.account}:${resource}`;

    const securityGroups = arn('ec2', 'security-group/*');
    const nlbs = arn('elasticloadbalancing', 'loadbalancer/net/*/*');
    const targetGroups = arn('elasticloadbalancing', 'targetgroup/*/*');
    const nlbListeners = arn('elasticloadbalancing', 'listener/net/*/*/*');

    const clusterTag = LB_CONTROLLER_CLUSTER_TAG;
    /** The resource already carries this cluster's tag. */
    const ownedByThisCluster = { [`aws:ResourceTag/${clusterTag}`]: props.clusterName };
    /** The request sets this cluster's tag. */
    const taggedForThisCluster = { [`aws:RequestTag/${clusterTag}`]: props.clusterName };
    /** The request does not touch the cluster tag (it cannot be moved or removed). */
    const leavesClusterTagAlone = { [`aws:RequestTag/${clusterTag}`]: 'true' };

    const allow = (sid: string, s: Omit<ConstructorParameters<typeof PolicyStatement>[0], 'sid' | 'effect'>) =>
      this.role.addToPolicy(new PolicyStatement({ sid, effect: Effect.ALLOW, ...s }));

    // --- Read ---------------------------------------------------------
    // Describe/Get calls cannot be limited to a resource, so `*` is the
    // only form AWS accepts. Limited to our region instead.
    allow('ReadInRegion', {
      actions: [
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
      ],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
    });

    // --- One-off: the load balancing service's own role ----------------
    // AWS creates this the first time an account uses a load balancer.
    // One exact ARN, one service.
    allow('CreateElbServiceLinkedRole', {
      actions: ['iam:CreateServiceLinkedRole'],
      resources: [
        `arn:${stack.partition}:iam::${stack.account}:role/aws-service-role/` +
          'elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing',
      ],
      conditions: { StringEquals: { 'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com' } },
    });

    // --- Security groups ------------------------------------------------
    // AWS checks CreateSecurityGroup against the new group AND the VPC it
    // goes into. Naming only our VPC means: in our VPC or not at all.
    allow('CreateSecurityGroupInProjectVpc', {
      actions: ['ec2:CreateSecurityGroup'],
      resources: [securityGroups, props.vpc.vpcArn],
    });
    allow('TagSecurityGroupOnCreate', {
      actions: ['ec2:CreateTags'],
      resources: [securityGroups],
      conditions: { StringEquals: { 'ec2:CreateAction': 'CreateSecurityGroup', ...taggedForThisCluster } },
    });
    allow('RetagOwnSecurityGroups', {
      actions: ['ec2:CreateTags', 'ec2:DeleteTags'],
      resources: [securityGroups],
      conditions: { StringEquals: ownedByThisCluster, Null: leavesClusterTagAlone },
    });
    // The controller must add a rule to the cluster's own security group
    // (the one on the pods) to let the NLB in. That group does not carry
    // the controller's tag, so the limit here is the VPC, not the tag.
    allow('SecurityGroupRulesInProjectVpc', {
      actions: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
      resources: [securityGroups],
      conditions: { ArnEquals: { 'ec2:Vpc': props.vpc.vpcArn } },
    });
    allow('DeleteOwnSecurityGroups', {
      actions: ['ec2:DeleteSecurityGroup'],
      resources: [securityGroups],
      conditions: { StringEquals: ownedByThisCluster },
    });

    // --- Load balancer, target groups, listeners ------------------------
    allow('CreateNlbTaggedForThisCluster', {
      actions: ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateTargetGroup'],
      resources: [nlbs, targetGroups],
      conditions: { StringEquals: taggedForThisCluster },
    });
    allow('TagNlbOnCreate', {
      actions: ['elasticloadbalancing:AddTags'],
      resources: [nlbs, targetGroups],
      conditions: {
        StringEquals: {
          'elasticloadbalancing:CreateAction': ['CreateLoadBalancer', 'CreateTargetGroup'],
          ...taggedForThisCluster,
        },
      },
    });
    // Known gap (ADR-0036): AWS documents the CreateAction condition for
    // load balancers and target groups only, so this statement cannot say
    // "only while creating a listener". It could tag another project's
    // NLB listener in this region as ours. Still narrower than upstream,
    // which allows any tag on any listener.
    allow('TagListenerOnCreate', {
      actions: ['elasticloadbalancing:AddTags'],
      resources: [nlbListeners],
      conditions: { StringEquals: taggedForThisCluster },
    });
    allow('RetagOwnElbResources', {
      actions: ['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
      resources: [nlbs, targetGroups, nlbListeners],
      conditions: { StringEquals: ownedByThisCluster, Null: leavesClusterTagAlone },
    });
    allow('ManageOwnElbResources', {
      actions: [
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:ModifyListenerAttributes',
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:SetIpAddressType',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
      ],
      resources: [nlbs, targetGroups, nlbListeners],
      conditions: { StringEquals: ownedByThisCluster },
    });

    // -----------------------------------------------------------------
    // cdk-nag exceptions — approved by the project owner on 2026-11-26
    // (ADR-0036). AwsSolutions-IAM5 flags any `*` in a resource. Five
    // remain, one exception each, matching that exact string and nothing
    // else. A sixth wildcard, or one of these on another role, is an
    // error.
    // -----------------------------------------------------------------
    const idWildcard = (resource: string, why: string) => ({
      id: 'AwsSolutions-IAM5',
      reason: `${why} Approved 2026-11-26.`,
      appliesTo: [{ regex: `/^Resource::arn:<AWS::Partition>:[a-z0-9]+:[a-z0-9-]+:[^:]+:${resource}$/g` }],
    });
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Read-only Describe/Get calls. AWS does not support resource-level permissions ' +
            'for them, so "*" is the only valid form; limited to one region by condition. ' +
            'Approved 2026-11-26.',
          appliesTo: ['Resource::*'],
        },
        idWildcard(
          'security-group\\/\\*',
          'Security group ids do not exist until creation. Every statement on this ARN is ' +
            'limited by the project VPC or by the cluster tag.',
        ),
        idWildcard(
          'loadbalancer\\/net\\/\\*\\/\\*',
          'NLB names and ids are chosen at creation. Limited by the cluster tag.',
        ),
        idWildcard(
          'targetgroup\\/\\*\\/\\*',
          'Target group names and ids are chosen at creation. Limited by the cluster tag.',
        ),
        idWildcard(
          'listener\\/net\\/\\*\\/\\*\\/\\*',
          'Listener ids are chosen at creation. Limited by the cluster tag (one gap: ADR-0036).',
        ),
      ],
      true,
    );
  }
}

import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * Properties for the {@link KmsStack}.
 */
export interface KmsStackProps extends StackProps {
  /**
   * Time between "scheduled deletion" and actual removal of a KMS key. AWS
   * enforces a minimum of 7 days and a maximum of 30. Set to 7 in dev so
   * `cdk destroy` doesn't leave keys lingering for a month.
   *
   * @default Duration.days(7)
   */
  readonly pendingWindow?: Duration;
}

/**
 * Customer-managed KMS keys (CMKs) for the IDP platform.
 *
 * See docs/adr/0008-customer-managed-kms-keys.md for the rationale on
 * CMKs vs AWS-managed keys and the one-key-per-domain layout.
 *
 * Three keys, one per data domain (blast radius containment):
 *   - eksSecretsKey — envelope encryption for Kubernetes Secrets
 *   - logsKey       — encryption for CloudWatch log groups
 *   - ecrKey        — encryption for ECR image layers
 *
 * Every key has:
 *   - Annual rotation on (free with CMKs, no reason to disable).
 *   - RemovalPolicy.DESTROY so `cdk destroy` cleans up in dev.
 *   - Short pending-deletion window so re-deploy iteration doesn't
 *     get blocked by orphaned pending-delete keys.
 */
export class KmsStack extends Stack {
  public readonly eksSecretsKey: Key;
  public readonly logsKey: Key;
  public readonly ecrKey: Key;

  constructor(scope: Construct, id: string, props: KmsStackProps = {}) {
    super(scope, id, props);

    const pendingWindow = props.pendingWindow ?? Duration.days(7);

    this.eksSecretsKey = new Key(this, 'EksSecretsKey', {
      alias: 'idp/eks-secrets',
      description: 'Envelope encryption for EKS Kubernetes Secrets',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow,
    });

    this.logsKey = new Key(this, 'LogsKey', {
      alias: 'idp/logs',
      description:
        'Encryption for CloudWatch log groups (VPC flow logs, EKS control plane logs, workload logs)',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow,
    });

    this.ecrKey = new Key(this, 'EcrKey', {
      alias: 'idp/ecr',
      description: 'Encryption for ECR repository image layers',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow,
    });
  }
}

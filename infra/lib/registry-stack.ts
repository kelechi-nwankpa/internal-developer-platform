import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  Repository,
  RepositoryEncryption,
  TagMutability,
  TagStatus,
} from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * Properties for the {@link RegistryStack}.
 */
export interface RegistryStackProps extends StackProps {
  /**
   * KMS CMK for ECR image layer encryption (from KmsStack; see ADR-0008).
   */
  readonly ecrKey: kms.IKey;

  /**
   * Number of untagged images to keep before oldest gets garbage-collected.
   *
   * @default 10
   */
  readonly untaggedRetentionCount?: number;

  /**
   * Maximum age of any image before it is deleted. Prevents unbounded
   * storage growth even for tagged images that we forgot about.
   *
   * @default Duration.days(90)
   */
  readonly maxImageAge?: Duration;
}

/**
 * Container image registries for the IDP platform.
 *
 * Two repositories, one per domain (see ADR-0011):
 *   - platformRepo (`idp/platform`) — platform-team-owned images
 *     (Backstage build, custom controllers, ArgoCD image updater).
 *   - appsRepo    (`idp/apps`)     — application images produced by
 *     services scaffolded through the Phase 6 golden path template.
 *
 * Every repo:
 *   - KMS-encrypted via the ECR CMK from KmsStack.
 *   - Immutable tags (once foo:v1 pushed, it's frozen).
 *   - Scan on push enabled (basic ECR scanning, free).
 *   - Lifecycle: keep last N untagged + delete anything older than maxImageAge.
 *   - RemovalPolicy DESTROY + emptyOnDelete so `cdk destroy` is clean in dev.
 */
export class RegistryStack extends Stack {
  public readonly platformRepo: Repository;
  public readonly appsRepo: Repository;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);

    const untaggedRetentionCount = props.untaggedRetentionCount ?? 10;
    const maxImageAge = props.maxImageAge ?? Duration.days(90);

    this.platformRepo = this.makeRepo(
      'PlatformRepo',
      'idp/platform',
      props.ecrKey,
      untaggedRetentionCount,
      maxImageAge,
    );

    this.appsRepo = this.makeRepo(
      'AppsRepo',
      'idp/apps',
      props.ecrKey,
      untaggedRetentionCount,
      maxImageAge,
    );
  }

  private makeRepo(
    id: string,
    name: string,
    encryptionKey: kms.IKey,
    untaggedRetentionCount: number,
    maxImageAge: Duration,
  ): Repository {
    return new Repository(this, id, {
      repositoryName: name,
      encryption: RepositoryEncryption.KMS,
      encryptionKey,
      imageScanOnPush: true,
      imageTagMutability: TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          description: `Keep at most ${untaggedRetentionCount} untagged images`,
          tagStatus: TagStatus.UNTAGGED,
          maxImageCount: untaggedRetentionCount,
        },
        {
          description: `Delete any image older than ${maxImageAge.toDays()} days`,
          maxImageAge,
        },
      ],
    });
  }
}

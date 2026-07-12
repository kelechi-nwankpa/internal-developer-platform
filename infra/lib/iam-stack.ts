import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import {
  Effect,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Properties for the {@link IamStack}.
 */
export interface IamStackProps extends StackProps {
  /**
   * GitHub org / user that owns the repository.
   */
  readonly githubOrg: string;

  /**
   * Repository name that will assume the deploy role.
   */
  readonly githubRepo: string;

  /**
   * GitHub OIDC `sub` claim patterns that are allowed to assume the deploy
   * role. Each entry is appended to `repo:<org>/<repo>:`. Common values:
   *   - `ref:refs/heads/main` — only workflow runs on main
   *   - `ref:refs/tags/*`     — only tag-triggered releases
   *   - `pull_request`        — only pull-request event workflows
   *   - `environment:prod`    — only jobs using the "prod" GitHub environment
   *
   * @default ['ref:refs/heads/main']
   */
  readonly allowedRefs?: string[];
}

/**
 * IAM baseline for the platform.
 *
 * Establishes trust between AWS and GitHub Actions via OIDC federation
 * (ADR-0009). GitHub Actions workflows can assume {@link githubDeployRole}
 * without any long-lived AWS credentials in the repo — the trust is
 * cryptographic, per-run, and audited in CloudTrail.
 *
 * The deploy role is intentionally scoped to `sts:AssumeRole` on the
 * CDK bootstrap roles only. GitHub Actions never touches AWS APIs
 * directly; it runs `cdk deploy`, which assumes the bootstrap roles
 * to do the actual work. This is layered least-privilege.
 */
export class IamStack extends Stack {
  public readonly githubOidcProvider: OpenIdConnectProvider;
  public readonly githubDeployRole: Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    const allowedRefs = props.allowedRefs ?? ['ref:refs/heads/main'];

    // ---------------------------------------------------------------
    // GitHub Actions OIDC identity provider.
    // AWS auto-retrieves the current thumbprints for
    // token.actions.githubusercontent.com since 2023 — no manual pin
    // required. `sts.amazonaws.com` is GitHub's documented audience.
    // ---------------------------------------------------------------
    this.githubOidcProvider = new OpenIdConnectProvider(
      this,
      'GitHubOidcProvider',
      {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      },
    );

    // Build the `sub` claim allowlist. Each entry becomes a full
    // `repo:<org>/<repo>:<refPattern>` string.
    const subPatterns = allowedRefs.map(
      (ref) => `repo:${props.githubOrg}/${props.githubRepo}:${ref}`,
    );

    // ---------------------------------------------------------------
    // Deploy role that GitHub Actions can assume via WebIdentity.
    // Trust policy checks BOTH `aud` and `sub` — `aud` alone is not
    // enough (any GitHub user could assume the role); `sub` alone is
    // not enough (token could be reused across AWS services).
    // ---------------------------------------------------------------
    this.githubDeployRole = new Role(this, 'GitHubDeployRole', {
      roleName: 'idp-github-deploy',
      description:
        `Role for GitHub Actions in ${props.githubOrg}/${props.githubRepo} ` +
        `to invoke cdk deploy. Trust scoped to allowed sub patterns.`,
      assumedBy: new WebIdentityPrincipal(
        this.githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': subPatterns,
          },
        },
      ),
    });

    // Least-privilege permissions: only allow assuming the CDK bootstrap
    // roles. `cdk-hnb659fds-*` is the default CDK bootstrap qualifier;
    // if the account was bootstrapped with `--qualifier`, adjust here.
    const cdkQualifier = 'hnb659fds';
    const cdkRoleArns = [
      `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-deploy-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-file-publishing-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-image-publishing-role-${this.account}-${this.region}`,
      `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-lookup-role-${this.account}-${this.region}`,
    ];

    this.githubDeployRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: cdkRoleArns,
      }),
    );

    // ---------------------------------------------------------------
    // Outputs — the deploy-role ARN is what Phase 7's GitHub Actions
    // workflow references via `aws-actions/configure-aws-credentials`.
    // ---------------------------------------------------------------
    new CfnOutput(this, 'GitHubDeployRoleArn', {
      value: this.githubDeployRole.roleArn,
      description:
        'ARN of the role that GitHub Actions assumes via OIDC ' +
        'federation. Wire this into aws-actions/configure-aws-credentials.',
      exportName: `${this.stackName}-GitHubDeployRoleArn`,
    });

    new CfnOutput(this, 'GitHubOidcProviderArn', {
      value: this.githubOidcProvider.openIdConnectProviderArn,
      description: 'ARN of the GitHub OIDC identity provider',
      exportName: `${this.stackName}-GitHubOidcProviderArn`,
    });
  }
}

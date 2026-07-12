import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam-stack';

describe('IamStack', () => {
  const props = {
    env: { account: '123456789012', region: 'eu-west-1' },
    githubOrg: 'kelechi-nwankpa',
    githubRepo: 'internal-developer-platform',
  };

  let template: Template;
  let stack: IamStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new IamStack(app, 'TestIamStack', props);
    template = Template.fromStack(stack);
  });

  it('creates exactly one OIDC identity provider pointing at GitHub', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: Match.arrayWith(['sts.amazonaws.com']),
    });
  });

  it('creates the GitHub deploy role with a stable name', () => {
    // Note: CDK's OpenIdConnectProvider is a custom resource whose Lambda
    // handler has its own IAM::Role. So we filter by RoleName instead of
    // counting AWS::IAM::Role globally.
    const namedDeployRoles = template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'idp-github-deploy' },
    });
    expect(Object.keys(namedDeployRoles)).toHaveLength(1);
  });

  it('trusts GitHub OIDC via aud=sts.amazonaws.com AND sub=refs/heads/main', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
              StringLike: {
                'token.actions.githubusercontent.com:sub': Match.arrayWith([
                  'repo:kelechi-nwankpa/internal-developer-platform:ref:refs/heads/main',
                ]),
              },
            },
          }),
        ]),
      }),
    });
  });

  it('grants sts:AssumeRole ONLY on the 4 CDK bootstrap roles (no wildcards)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: Match.arrayEquals([
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-eu-west-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-file-publishing-role-123456789012-eu-west-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-image-publishing-role-123456789012-eu-west-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-lookup-role-123456789012-eu-west-1',
            ]),
          }),
        ]),
      }),
    });
  });

  it('emits CloudFormation outputs for the deploy role and OIDC provider ARNs', () => {
    template.hasOutput('GitHubDeployRoleArn', {
      Export: {
        Name: 'TestIamStack-GitHubDeployRoleArn',
      },
    });
    template.hasOutput('GitHubOidcProviderArn', {
      Export: {
        Name: 'TestIamStack-GitHubOidcProviderArn',
      },
    });
  });

  it('respects custom allowedRefs (e.g., tag releases and prod env)', () => {
    const app = new cdk.App();
    const customStack = new IamStack(app, 'CustomIamStack', {
      ...props,
      allowedRefs: [
        'ref:refs/tags/v*',
        'environment:prod',
      ],
    });
    const custom = Template.fromStack(customStack);

    custom.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': Match.arrayWith([
                  'repo:kelechi-nwankpa/internal-developer-platform:ref:refs/tags/v*',
                  'repo:kelechi-nwankpa/internal-developer-platform:environment:prod',
                ]),
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('exposes deploy role and OIDC provider as stack members for cross-stack use', () => {
    expect(stack.githubDeployRole).toBeDefined();
    expect(stack.githubOidcProvider).toBeDefined();
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

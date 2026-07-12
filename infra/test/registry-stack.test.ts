import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { RegistryStack } from '../lib/registry-stack';

function synthRegistryStack() {
  const app = new cdk.App();

  const scaffoldStack = new cdk.Stack(app, 'ScaffoldStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
  });
  const ecrKey = new kms.Key(scaffoldStack, 'HarnessEcrKey');

  const stack = new RegistryStack(app, 'TestRegistryStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
    ecrKey,
  });

  return { stack, template: Template.fromStack(stack) };
}

describe('RegistryStack', () => {
  let template: Template;
  let stack: RegistryStack;

  beforeAll(() => {
    ({ stack, template } = synthRegistryStack());
  });

  it('creates exactly 2 ECR repositories', () => {
    template.resourceCountIs('AWS::ECR::Repository', 2);
  });

  it('names the repos idp/platform and idp/apps', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    const names = Object.values(repos)
      .map((r) => r.Properties.RepositoryName as string)
      .sort();
    expect(names).toEqual(['idp/apps', 'idp/platform']);
  });

  it('enables KMS encryption on every repository', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      expect(repo.Properties.EncryptionConfiguration.EncryptionType).toBe('KMS');
      expect(repo.Properties.EncryptionConfiguration.KmsKey).toBeDefined();
    }
  });

  it('enables scan on push on every repository', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      expect(repo.Properties.ImageScanningConfiguration.ScanOnPush).toBe(true);
    }
  });

  it('makes every image tag IMMUTABLE (ADR-0011)', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      expect(repo.Properties.ImageTagMutability).toBe('IMMUTABLE');
    }
  });

  it('applies a lifecycle policy with 2 rules per repository', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      const lifecyclePolicy = repo.Properties.LifecyclePolicy?.LifecyclePolicyText as string | undefined;
      expect(lifecyclePolicy).toBeDefined();
      const parsed = JSON.parse(lifecyclePolicy!);
      expect(parsed.rules).toHaveLength(2);
    }
  });

  it('marks every repository with Delete on stack removal', () => {
    const repos = template.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      expect(repo.DeletionPolicy).toBe('Delete');
      expect(repo.UpdateReplacePolicy).toBe('Delete');
    }
  });

  it('respects a custom untaggedRetentionCount and maxImageAge', () => {
    const app = new cdk.App();
    const scaffoldStack = new cdk.Stack(app, 'S2', {
      env: { account: '123456789012', region: 'eu-west-1' },
    });
    const key = new kms.Key(scaffoldStack, 'K2');
    const customStack = new RegistryStack(app, 'CustomRegistryStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
      ecrKey: key,
      untaggedRetentionCount: 3,
      maxImageAge: cdk.Duration.days(14),
    });
    const custom = Template.fromStack(customStack);

    const repos = custom.findResources('AWS::ECR::Repository');
    for (const repo of Object.values(repos)) {
      const rules = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText).rules;
      const untagged = rules.find(
        (r: { selection: { tagStatus: string } }) => r.selection.tagStatus === 'untagged',
      );
      expect(untagged.selection.countNumber).toBe(3);

      const aged = rules.find(
        (r: { selection: { tagStatus: string; countType: string } }) =>
          r.selection.countType === 'sinceImagePushed',
      );
      expect(aged.selection.countNumber).toBe(14);
    }
  });

  it('exposes platformRepo and appsRepo as public stack members', () => {
    expect(stack.platformRepo).toBeDefined();
    expect(stack.appsRepo).toBeDefined();
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

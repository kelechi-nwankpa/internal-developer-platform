import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../lib/kms-stack';

describe('KmsStack', () => {
  let template: Template;
  let stack: KmsStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new KmsStack(app, 'TestKmsStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
  });

  it('creates exactly 3 CMKs — one per data domain', () => {
    template.resourceCountIs('AWS::KMS::Key', 3);
  });

  it('creates 3 KMS aliases matching the 3 keys', () => {
    template.resourceCountIs('AWS::KMS::Alias', 3);
  });

  it('enables annual rotation on every key (ADR-0008)', () => {
    const keys = template.findResources('AWS::KMS::Key');
    expect(Object.keys(keys)).toHaveLength(3);
    for (const key of Object.values(keys)) {
      expect(key.Properties.EnableKeyRotation).toBe(true);
    }
  });

  it('sets a 7-day pending-deletion window on every key', () => {
    const keys = template.findResources('AWS::KMS::Key');
    for (const key of Object.values(keys)) {
      expect(key.Properties.PendingWindowInDays).toBe(7);
    }
  });

  it('marks every key with RemovalPolicy.Delete for dev cleanup', () => {
    const keys = template.findResources('AWS::KMS::Key');
    for (const key of Object.values(keys)) {
      expect(key.DeletionPolicy).toBe('Delete');
      expect(key.UpdateReplacePolicy).toBe('Delete');
    }
  });

  it('names the three aliases idp/eks-secrets, idp/logs, idp/ecr', () => {
    const aliases = template.findResources('AWS::KMS::Alias');
    const aliasNames = Object.values(aliases).map(
      (a) => a.Properties.AliasName as string,
    );
    expect(aliasNames.sort()).toEqual(
      ['alias/idp/ecr', 'alias/idp/eks-secrets', 'alias/idp/logs'].sort(),
    );
  });

  it('exposes each key as a public stack member for cross-stack imports', () => {
    expect(stack.eksSecretsKey).toBeDefined();
    expect(stack.logsKey).toBeDefined();
    expect(stack.ecrKey).toBeDefined();
  });

  it('respects a custom pendingWindow', () => {
    const app = new cdk.App();
    const custom = new KmsStack(app, 'CustomKmsStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
      pendingWindow: cdk.Duration.days(30),
    });
    const customTemplate = Template.fromStack(custom);
    const keys = customTemplate.findResources('AWS::KMS::Key');
    for (const key of Object.values(keys)) {
      expect(key.Properties.PendingWindowInDays).toBe(30);
    }
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

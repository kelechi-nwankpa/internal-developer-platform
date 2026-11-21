import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CostStack } from '../lib/cost-stack';
import { TEARDOWN_DEADLINE_PARAM } from '../lib/teardown-timer';

const GROUPS = [
  ['ClusterStack', 'RegistryStack', 'DnsStack', 'IamStack'],
  ['VpcStack', 'KmsStack'],
];
const ENV = { account: '123456789012', region: 'eu-west-1' };

function build(groups: string[][] | undefined = GROUPS): Template {
  const app = new cdk.App();
  const stack = new CostStack(app, 'CostStack', {
    env: ENV,
    notificationEmail: 'test@example.com',
    teardownStackGroups: groups,
  });
  return Template.fromStack(stack);
}

/** Every IAM statement in the template, flattened. */
function statements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

describe('TeardownTimer (inside CostStack)', () => {
  const template = build();

  it('is absent unless stack groups are given', () => {
    const app = new cdk.App();
    const stack = new CostStack(app, 'CostStack', { env: ENV, notificationEmail: 'test@example.com' });
    Template.fromStack(stack).resourceCountIs('AWS::Lambda::Function', 0);
  });

  it('runs every 15 minutes', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
      State: 'ENABLED',
    });
  });

  it('passes the groups, deadline parameter and hours to the function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.15',
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          STACK_GROUPS: 'ClusterStack,RegistryStack,DnsStack,IamStack;VpcStack,KmsStack',
          DEADLINE_PARAM: TEARDOWN_DEADLINE_PARAM,
          DEFAULT_HOURS: '4',
          MAX_HOURS: '12',
        }),
      },
    });
  });

  it('may describe and delete exactly the six named stacks, nothing else in CloudFormation', () => {
    const cfn = statements(template).filter((s) => [s.Action].flat().some((a: string) => a.startsWith('cloudformation:')));
    expect(cfn).toHaveLength(1);
    expect(cfn[0].Action).toEqual(['cloudformation:DescribeStacks', 'cloudformation:DeleteStack']);
    const arns = cfn[0].Resource.map((r: any) => JSON.stringify(r));
    expect(arns).toHaveLength(6);
    for (const name of GROUPS.flat()) {
      expect(arns.some((a: string) => a.includes(`:cloudformation:eu-west-1:123456789012:stack/${name}/*`))).toBe(true);
    }
  });

  it('can never delete its own stack (that would remove the budget alarms)', () => {
    expect(JSON.stringify(statements(template))).not.toContain('stack/CostStack/');
    expect(() => build([['ClusterStack'], ['CostStack']])).toThrow(/must not target its own stack/);
  });

  it('has no statement with a bare "*" resource and no wildcard action', () => {
    for (const s of statements(template)) {
      expect([s.Resource].flat()).not.toContain('*');
      for (const a of [s.Action].flat()) expect(a).not.toMatch(/\*/);
    }
  });

  it('holds only the actions it needs', () => {
    const actions = statements(template)
      .flatMap((s) => [s.Action].flat())
      .sort();
    expect(actions).toEqual([
      'cloudformation:DeleteStack',
      'cloudformation:DescribeStacks',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'sns:Publish',
      'ssm:DeleteParameter',
      'ssm:GetParameter',
      'ssm:PutParameter',
    ]);
  });

  it('limits parameter access to the one deadline parameter', () => {
    const ssm = statements(template).find((s) => [s.Action].flat().includes('ssm:PutParameter'));
    expect(JSON.stringify(ssm.Resource)).toContain(`:ssm:eu-west-1:123456789012:parameter${TEARDOWN_DEADLINE_PARAM}`);
    expect(JSON.stringify(ssm.Resource)).not.toContain('parameter/*');
  });

  it('uses no AWS-managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
  });

  it('keeps its logs for one month, not forever', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('emails the configured address', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'test@example.com' });
  });

  it('rejects an empty group list and impossible hours', () => {
    expect(() => build([[]])).toThrow(/at least one stack/);
  });
});

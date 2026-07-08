import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CostStack } from '../lib/cost-stack';

describe('CostStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new CostStack(app, 'TestCostStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
      notificationEmail: 'test@example.com',
    });
    template = Template.fromStack(stack);
  });

  it('creates one Budget per threshold (4 total by default)', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 4);
  });

  it('creates a single Cost Anomaly Monitor at the SERVICE dimension', () => {
    template.resourceCountIs('AWS::CE::AnomalyMonitor', 1);
    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });
  });

  it('creates a single Cost Anomaly Subscription with DAILY frequency', () => {
    template.resourceCountIs('AWS::CE::AnomalySubscription', 1);
    template.hasResourceProperties('AWS::CE::AnomalySubscription', {
      Frequency: 'DAILY',
    });
  });

  it('scopes every Budget to the Project=idp tag', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        CostFilters: {
          TagKeyValue: Match.arrayWith(['user:Project$idp']),
        },
      }),
    });
  });

  it('routes every Budget alarm to the configured email', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: Match.arrayWith([
            Match.objectLike({
              Address: 'test@example.com',
              SubscriptionType: 'EMAIL',
            }),
          ]),
        }),
      ]),
    });
  });

  it('emits ACTUAL (not FORECASTED) budget alarms at 100% threshold', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          }),
        }),
      ]),
    });
  });

  it('respects a custom notificationEmail and projectTag', () => {
    const app = new cdk.App();
    const customStack = new CostStack(app, 'CustomCostStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
      notificationEmail: 'custom@example.com',
      projectTag: 'other',
    });
    const custom = Template.fromStack(customStack);

    custom.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        CostFilters: {
          TagKeyValue: Match.arrayWith(['user:Project$other']),
        },
      }),
    });
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

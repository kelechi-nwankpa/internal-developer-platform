import { Stack, StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { CfnAnomalyMonitor, CfnAnomalySubscription } from 'aws-cdk-lib/aws-ce';
import { Construct } from 'constructs';

/**
 * Properties for the {@link CostStack}.
 */
export interface CostStackProps extends StackProps {
  /**
   * Email address for AWS Budgets and Cost Anomaly Detection notifications.
   * Every budget alarm and the anomaly subscription send here.
   */
  readonly notificationEmail: string;

  /**
   * Budget thresholds in USD. Each threshold gets its own budget that
   * alarms at 100% ACTUAL spend on resources tagged `Project=<projectTag>`.
   *
   * @default [5, 15, 30, 50]
   */
  readonly budgetLimits?: number[];

  /**
   * Project tag value used as the Budget cost filter.
   *
   * @default 'idp'
   */
  readonly projectTag?: string;

  /**
   * Minimum anomaly impact in USD before Anomaly Detection sends an email.
   *
   * @default 1
   */
  readonly anomalyThresholdUsd?: number;
}

/**
 * Cost guardrails for the IDP project.
 *
 * Deployed BEFORE any workload stack. If this stack fails to deploy, no
 * subsequent stack should be deployed — the alarms are the safety net.
 *
 * Design notes:
 * - Budgets filter on tag `Project=<projectTag>` (see App-level `Tags.of`
 *   in `bin/idp.ts`). Untagged spend is *not* alarmed here — this stack
 *   is intentionally scoped.
 * - All resources are L1 (`Cfn*`) because CDK does not yet provide L2
 *   constructs for `aws-budgets` or `aws-ce`. Inventing wrappers "for
 *   consistency" would just re-export CloudFormation with extra indirection.
 */
export class CostStack extends Stack {
  constructor(scope: Construct, id: string, props: CostStackProps) {
    super(scope, id, props);

    const projectTag = props.projectTag ?? 'idp';
    const budgetLimits = props.budgetLimits ?? [5, 15, 30, 50];
    const anomalyThresholdUsd = props.anomalyThresholdUsd ?? 1;

    // -----------------------------------------------------------------
    // Budgets — one per threshold.
    // AWS uses `user:<TagKey>$<TagValue>` in the CostFilters format.
    // See: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_CostTypes.html
    // -----------------------------------------------------------------
    budgetLimits.forEach((amount) => {
      new CfnBudget(this, `Budget${amount}USD`, {
        budget: {
          budgetName: `idp-${amount}usd-actual`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: {
            amount,
            unit: 'USD',
          },
          costFilters: {
            TagKeyValue: [`user:Project$${projectTag}`],
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'ACTUAL',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers: [
              {
                subscriptionType: 'EMAIL',
                address: props.notificationEmail,
              },
            ],
          },
        ],
      });
    });

    // -----------------------------------------------------------------
    // Cost Anomaly Detection.
    // The monitor observes each AWS service dimension for the account.
    // The subscription batches daily alerts to the notification email
    // once an anomaly of at least `anomalyThresholdUsd` is detected.
    // -----------------------------------------------------------------
    // AWS Cost Explorer resources are ACCOUNT-GLOBAL — a monitor named
    // `idp-anomaly-monitor` claims the name across the whole account, so
    // deploying this stack in two regions would collide. Scoping the name
    // with the stack's region turns a global identifier into a
    // per-region-deployable one without changing behaviour (monitors
    // observe the whole account either way).
    const monitor = new CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: `idp-anomaly-monitor-${this.region}`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    new CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: `idp-anomaly-subscription-${this.region}`,
      frequency: 'DAILY',
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [
        {
          type: 'EMAIL',
          address: props.notificationEmail,
        },
      ],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [anomalyThresholdUsd.toString()],
        },
      }),
    });
  }
}

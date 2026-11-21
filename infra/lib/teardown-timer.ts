import * as path from 'path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFn, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** Where `make aws-extend` writes a later deadline. Not created here. */
export const TEARDOWN_DEADLINE_PARAM = '/idp/teardown/deadline';

export interface TeardownTimerProps {
  /**
   * Stacks to delete at the deadline, in groups. A group is deleted once
   * the groups before it are gone (or stuck). Stacks that others depend
   * on go in later groups: the cluster before the VPC it lives in.
   */
  readonly stackGroups: string[][];

  /** Where the warning and result emails go. */
  readonly notificationEmail: string;

  /**
   * Hours after the oldest stack was created before deletion starts.
   * @default 4 — one planned 3-hour session plus slack (docs/COST.md)
   */
  readonly defaultHours?: number;

  /**
   * The latest `make aws-extend` can push the deadline, in hours after
   * creation. A cap, so a typo cannot switch the timer off.
   * @default 12
   */
  readonly maxHours?: number;
}

/**
 * Dead-man's switch for a forgotten AWS session.
 *
 * WHY: every other cost guard needs a person at the keyboard. Phase 1's
 * cluster ran 23 hours and cost $27.17 because nobody was there
 * (docs/COST.md). This runs in AWS and needs nobody.
 *
 * WHAT: a rule runs a small Lambda every 15 minutes. With no workload
 * stacks it does nothing. Once the oldest stack is `defaultHours` old (or
 * the extended deadline passes) it asks CloudFormation to delete the
 * stacks, and keeps asking until they are gone. It emails a warning
 * about 30 minutes before, and the outcome. Logic and its limits:
 * infra/lambda/teardown-timer/index.py.
 *
 * WHY it lives in CostStack: it must outlive the session. `make aws-down`
 * never removes CostStack, and `make aws-audit` already fails if
 * CostStack is missing.
 *
 * PERMISSIONS (deliberately narrow; the account is shared):
 *   - describe/delete exactly the named stacks. The delete itself is done
 *     by CloudFormation with the role each stack was deployed with, so
 *     this Lambda holds no right to delete an EKS cluster or a VPC
 *     directly.
 *   - read/write/delete the one deadline parameter
 *   - publish to its own topic; write its own logs
 *
 * COST: $0. 2,880 short runs a month against a free tier of 1,000,000;
 * EventBridge rules, a standard parameter and an email topic are free.
 *
 * Alternatives rejected:
 *   - An arm/disarm step in `make aws-up`: a step that can be skipped is
 *     the failure this exists to remove. The stack's own creation time
 *     is the clock.
 *   - Running `make aws-down` in CodeBuild at the deadline: thorough, but
 *     a standing role with broad delete rights that runs whatever is on
 *     the main branch.
 */
export class TeardownTimer extends Construct {
  public readonly topic: Topic;

  constructor(scope: Construct, id: string, props: TeardownTimerProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const names = props.stackGroups.flat();
    if (names.length === 0) {
      throw new Error('TeardownTimer needs at least one stack name');
    }
    if (names.includes(stack.stackName)) {
      // The timer deleting its own stack would remove the budget alarms.
      throw new Error(`TeardownTimer must not target its own stack (${stack.stackName})`);
    }
    const defaultHours = props.defaultHours ?? 4;
    const maxHours = props.maxHours ?? 12;
    if (!(defaultHours > 0 && maxHours >= defaultHours)) {
      throw new Error('TeardownTimer needs 0 < defaultHours <= maxHours');
    }

    this.topic = new Topic(this, 'Topic', {
      displayName: 'IDP teardown timer',
      enforceSSL: true,
    });
    this.topic.addSubscription(new EmailSubscription(props.notificationEmail));

    // Own log group: a fixed retention (the default never expires — the
    // exact leftover the audit found from Phase 1) and a known ARN to
    // grant, instead of the broad AWS-managed logging policy.
    const logGroup = new LogGroup(this, 'Logs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Teardown timer: may delete only the named workload stacks',
    });

    const fn = new LambdaFn(this, 'Fn', {
      // Newest Python the installed aws-cdk-lib knows; bump with the lib.
      runtime: Runtime.PYTHON_3_15,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(__dirname, '..', 'lambda', 'teardown-timer'), {
        exclude: ['test_*.py', '__pycache__'],
      }),
      role,
      logGroup,
      timeout: Duration.seconds(60),
      memorySize: 128,
      description: 'Deletes the IDP workload stacks when a session is left running',
      environment: {
        STACK_GROUPS: props.stackGroups.map((g) => g.join(',')).join(';'),
        DEADLINE_PARAM: TEARDOWN_DEADLINE_PARAM,
        TOPIC_ARN: this.topic.topicArn,
        DEFAULT_HOURS: String(defaultHours),
        MAX_HOURS: String(maxHours),
      },
    });

    // The trailing /* is the stack's unique id, which changes on every
    // deploy; the name before it is exact.
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DeleteOnlyTheNamedStacks',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DeleteStack'],
        resources: names.map((n) => `arn:${stack.partition}:cloudformation:${stack.region}:${stack.account}:stack/${n}/*`),
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DeadlineParameter',
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${TEARDOWN_DEADLINE_PARAM}`],
      }),
    );
    this.topic.grantPublish(role);
    logGroup.grantWrite(role);

    new Rule(this, 'Every15Minutes', {
      description: 'Runs the IDP teardown timer',
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(fn, { retryAttempts: 2 })],
    });
  }
}

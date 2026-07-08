import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CostStack } from '../lib/cost-stack';
import { VpcStack } from '../lib/vpc-stack';

const app = new cdk.App();

// Deploy target is derived from ambient AWS credentials at the moment the
// CDK CLI runs. Hardcoding `account` here would decouple "where I'm
// authenticated" from "where CDK deploys" — a real security foot-gun.
// See ADR-0002 discussion in Task 1.1 and Phase 1 opening.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
};

// Tag every resource so Cost Explorer, AWS Budgets, and IAM condition
// keys can gate on `Project=idp`. Required for the CostStack budgets
// to filter this project's spend.
cdk.Tags.of(app).add('Project', 'idp');
cdk.Tags.of(app).add('ManagedBy', 'cdk');

// cdk-nag AwsSolutions ruleset applied to every stack in this app.
// Findings surface at `cdk synth` and block deploy. Any suppression
// must be justified in an ADR (see docs/adr/).
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Cost guardrails FIRST — before any workload stack. If this stack fails
// to deploy or fails cdk-nag, no other stack should ship.
new CostStack(app, 'CostStack', {
  env,
  notificationEmail: 'nwankpakelechisamuel@gmail.com',
  projectTag: 'idp',
});

// Network foundation — VPC with no NAT, VPC endpoints only (ADR-0007).
new VpcStack(app, 'VpcStack', {
  env,
});

// Stacks land here from Task 1.4 onward (KmsStack, IamStack, ClusterStack, ...).

app.synth();

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DnsStack } from '../lib/dns-stack';

function synthDnsStack(zoneName = 'idp.seniormankelz.dev') {
  const app = new cdk.App();
  const stack = new DnsStack(app, 'TestDnsStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
    zoneName,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('DnsStack', () => {
  let template: Template;
  let stack: DnsStack;

  beforeAll(() => {
    ({ stack, template } = synthDnsStack());
  });

  it('creates exactly one public HostedZone with the requested zone name', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'idp.seniormankelz.dev.', // Route53 stores names with trailing dot
    });
  });

  it('creates no RecordSets in Phase 1 (Phase 2 populates via ExternalDNS)', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('emits outputs for zone ID, ARN, and NS records', () => {
    template.hasOutput('HostedZoneId', {
      Export: { Name: 'TestDnsStack-HostedZoneId' },
    });
    template.hasOutput('HostedZoneArn', {
      Export: { Name: 'TestDnsStack-HostedZoneArn' },
    });
    template.hasOutput('NameServers', {
      Export: { Name: 'TestDnsStack-NameServers' },
    });
    template.hasOutput('ZoneName', {});
  });

  it('includes a comment on the hosted zone that points at the runbook', () => {
    // Use CDK's Match.stringLikeRegexp — jest matchers don't cross into
    // the aws-cdk-lib/assertions API.
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      HostedZoneConfig: Match.objectLike({
        Comment: Match.stringLikeRegexp('dns-delegation\\.md'),
      }),
    });
  });

  it('respects a custom zone name', () => {
    const { template: custom } = synthDnsStack('demo.example.org');
    custom.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'demo.example.org.',
    });
  });

  it('exposes hostedZone as a public stack member for cross-stack imports', () => {
    expect(stack.hostedZone).toBeDefined();
  });

  it('matches the snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

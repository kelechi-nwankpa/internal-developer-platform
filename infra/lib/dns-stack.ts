import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

/**
 * Properties for the {@link DnsStack}.
 */
export interface DnsStackProps extends StackProps {
  /**
   * Fully-qualified domain name of the subdomain to host, e.g.
   * `idp.seniormankelz.dev`. The apex (`seniormankelz.dev`) stays at
   * Namecheap; we delegate this subdomain to Route53 by adding NS
   * records for `idp` at the apex. See docs/runbooks/dns-delegation.md.
   */
  readonly zoneName: string;
}

/**
 * Public Route53 hosted zone for the platform subdomain.
 *
 * We deliberately create no record sets in Phase 1 — ExternalDNS and
 * cert-manager will populate the zone with A / AAAA / CNAME records
 * in Phase 2, driven by Ingress annotations on workloads.
 *
 * The 4 assigned nameservers are exposed as a stack output. Copy them
 * into Namecheap's Advanced DNS panel as NS records for the `idp`
 * label of the apex domain (subdomain delegation — see ADR-0012).
 * Once propagation completes (usually under an hour), the subdomain
 * becomes resolvable from anywhere on the internet.
 */
export class DnsStack extends Stack {
  public readonly hostedZone: HostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.hostedZone = new HostedZone(this, 'HostedZone', {
      zoneName: props.zoneName,
      comment:
        `Public hosted zone for ${props.zoneName}. ` +
        `Subdomain delegated from the apex at Namecheap. ` +
        `See docs/runbooks/dns-delegation.md.`,
    });

    // -----------------------------------------------------------------
    // Outputs — the values you actually need after `cdk deploy`.
    // -----------------------------------------------------------------
    new CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 hosted zone ID — consumed by ExternalDNS IAM policy in Phase 2',
      exportName: `${this.stackName}-HostedZoneId`,
    });

    new CfnOutput(this, 'HostedZoneArn', {
      value: this.hostedZone.hostedZoneArn,
      description: 'Route53 hosted zone ARN — used to scope IAM policies to this zone specifically',
      exportName: `${this.stackName}-HostedZoneArn`,
    });

    // The 4 assigned nameservers arrive as an unresolved token at synth
    // time; CFN resolves them at deploy. We join them into a single
    // comma-separated string so `cdk deploy` prints all four in one line.
    // If Route53 doesn't return nameservers for some reason (private
    // zone, custom config), the output is guarded.
    const nameServers = this.hostedZone.hostedZoneNameServers;
    if (nameServers) {
      new CfnOutput(this, 'NameServers', {
        value: Fn.join(',', nameServers),
        description:
          'Comma-separated list of the 4 Route53 nameservers. ' +
          'Copy each one into Namecheap Advanced DNS as an NS record for the `idp` label. ' +
          'See docs/runbooks/dns-delegation.md.',
        exportName: `${this.stackName}-NameServers`,
      });
    }

    new CfnOutput(this, 'ZoneName', {
      value: props.zoneName,
      description: 'The zone name (redundant with the stack parameter, but convenient for scripts)',
    });
  }
}

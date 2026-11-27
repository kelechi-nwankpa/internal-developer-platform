import { CfnJson } from 'aws-cdk-lib';
import { ICluster } from 'aws-cdk-lib/aws-eks';
import { Effect, FederatedPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Where cert-manager's controller runs in the cluster. The role below can
 * be used by this one ServiceAccount and nothing else, so the Helm
 * install (platform/) must use exactly these two names.
 */
export const CERT_MANAGER_NAMESPACE = 'cert-manager';
export const CERT_MANAGER_SERVICE_ACCOUNT = 'cert-manager';

/**
 * The name Let's Encrypt looks up to check that we own a domain. For
 * `example.com` and for `*.example.com` it is `_acme-challenge.example.com`
 * (RFC 8555, section 8.4).
 */
export const ACME_CHALLENGE_LABEL = '_acme-challenge';

export interface CertManagerRoleProps {
  /** The cluster whose OIDC provider signs the ServiceAccount's token. */
  readonly cluster: ICluster;

  /** The project's public DNS zone. Record changes are limited to it. */
  readonly hostedZone: IHostedZone;

  /**
   * The zone's name as plain text, without a trailing dot. Used to build
   * the record names the role may write.
   */
  readonly zoneName: string;
}

/**
 * IAM role for cert-manager (ADR-0038).
 *
 * To get a certificate from Let's Encrypt, cert-manager must prove we own
 * the domain. For a wildcard certificate the only accepted proof is
 * DNS-01: write a TXT record that Let's Encrypt then looks up. So
 * cert-manager needs to write into our Route53 zone.
 *
 * Whoever can write any record in a zone can point every hostname in it
 * somewhere else. So this role is not "edit the zone". It is limited
 * three ways:
 *
 *  - one zone: this project's, by its exact ARN;
 *  - one record type: TXT;
 *  - one family of names: `_acme-challenge.<zone>` and
 *    `_acme-challenge.<anything>.<zone>`.
 *
 * A stolen token can therefore get certificates issued for names in our
 * zone (that is what the challenge record is for) but cannot change
 * where any hostname points.
 *
 * cert-manager's documented policy allows all record types and names in
 * the zone; this one is narrower.
 *
 * Trust is IRSA, the ServiceAccount is created at bootstrap, and the
 * role has no fixed name, for the same reasons as the load balancer
 * controller's role (ADR-0036, ADR-0037).
 */
export class CertManagerRole extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: CertManagerRoleProps) {
    super(scope, id);

    const provider = props.cluster.openIdConnectProvider;
    const issuer = provider.openIdConnectProviderIssuer;

    // The issuer URL is part of the condition keys and only known at
    // deploy time; CfnJson builds the object then.
    const trustConditions = new CfnJson(this, 'TrustConditions', {
      value: {
        [`${issuer}:aud`]: 'sts.amazonaws.com',
        // Only the controller. cert-manager also runs a webhook and a
        // "cainjector" under other ServiceAccounts; neither calls AWS.
        [`${issuer}:sub`]: `system:serviceaccount:${CERT_MANAGER_NAMESPACE}:${CERT_MANAGER_SERVICE_ACCOUNT}`,
      },
    });

    this.role = new Role(this, 'Role', {
      description: `cert-manager DNS-01 challenges in ${props.zoneName} (ADR-0038)`,
      assumedBy: new FederatedPrincipal(
        provider.openIdConnectProviderArn,
        { StringEquals: trustConditions },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    const allow = (sid: string, s: Omit<ConstructorParameters<typeof PolicyStatement>[0], 'sid' | 'effect'>) =>
      this.role.addToPolicy(new PolicyStatement({ sid, effect: Effect.ALLOW, ...s }));

    const zone = props.hostedZone.hostedZoneArn;

    // cert-manager finds the zone by its name, so no zone id has to be
    // written into Git (ADR-0037). AWS accepts no resource for this call.
    // Read-only: it returns zone names and ids.
    allow('FindZoneByName', {
      actions: ['route53:ListHostedZonesByName'],
      resources: ['*'],
    });

    allow('ListRecordsInProjectZone', {
      actions: ['route53:ListResourceRecordSets'],
      resources: [zone],
    });

    // The one write. Route53 normalises names before comparing: lower
    // case, no trailing dot.
    allow('WriteAcmeChallengeRecords', {
      actions: ['route53:ChangeResourceRecordSets'],
      resources: [zone],
      conditions: {
        'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'] },
        'ForAllValues:StringLike': {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [
            `${ACME_CHALLENGE_LABEL}.${props.zoneName}`,
            `${ACME_CHALLENGE_LABEL}.*.${props.zoneName}`,
          ],
        },
      },
    });

    // After a change, cert-manager polls until Route53 reports it live.
    // The change id is made up by Route53 per change, so it cannot be
    // named in advance. Read-only: it returns "PENDING" or "INSYNC".
    allow('ReadChangeStatus', {
      actions: ['route53:GetChange'],
      resources: ['arn:aws:route53:::change/*'],
    });

    // -----------------------------------------------------------------
    // cdk-nag exceptions — approved by the project owner on 2026-11-27
    // (ADR-0038). AwsSolutions-IAM5 flags any `*` in a resource. Two
    // remain, both on read-only statements, one exception each, matching
    // that exact string and nothing else. A third wildcard, or one of
    // these on another role, is an error.
    // -----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'route53:ListHostedZonesByName is read-only and AWS supports no resource-level ' +
            'permission for it, so "*" is the only valid form. It lets cert-manager find the ' +
            'zone by name, so no zone id is kept in Git. Approved 2026-11-27.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'route53:GetChange is read-only. Route53 generates the change id per change, so ' +
            'it cannot be named in advance. Approved 2026-11-27.',
          appliesTo: ['Resource::arn:aws:route53:::change/*'],
        },
      ],
      true,
    );
  }
}

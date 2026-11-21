#!/usr/bin/env bash
# aws-audit.sh — ask AWS directly what is still there after a teardown.
# Read-only. Run: make aws-audit
#
# WHY: Phase 1's cluster ran 23 hours unnoticed and cost $27.17
# (docs/COST.md). "cdk destroy finished" is not proof that billing
# stopped: CloudFormation only knows what it created. A load balancer made
# by a Kubernetes Service, a bucket or IAM role made by Crossplane, or a
# stack stuck in DELETE_FAILED are all invisible to it. So this script
# does not ask CloudFormation what it thinks; it lists the resources.
#
# Two kinds of finding:
#   BILLS  charged by the hour or month while it exists. Exit 1.
#   LEFT   free (or near-free) leftover. It is clutter, and it can block
#          the next deploy. Warning only, unless --strict.
# Fails CLOSED: a check that cannot run counts as a failure, because "I
# could not look" must never read as "nothing there".
#
# Deliberately kept, never reported: the CDK bootstrap (CDKToolkit stack
# and its cdk-* bucket/repository) and CostStack (budget alarms, free).
# AUDIT_KEEP is an extra regular expression for things you keep on
# purpose, for example a permanent hosted zone:
#   AUDIT_KEEP='^seniormankelz\.dev\.' make aws-audit
#
# Scope: AWS_REGION plus the global services (IAM, Route 53, S3). A
# resource created by hand in another region is NOT seen. AUDIT_REGIONS
# can list more regions to check, space separated.
# The account is shared with other projects. Billing checks are
# account-wide on purpose (a forgotten instance costs the same whoever
# made it); S3, IAM and log-group checks look only at this project's
# names and tags.
#
# Cost of running this: $0 (no Cost Explorer calls).
#
# The filters below are pure (JSON in, findings out) and unit-tested by
# scripts/tests/aws-audit.test.sh, which sources this file.

set -uo pipefail

RED=$'\033[1;31m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
BILLS=0; LEFT=0; ERRORS=0

# Names never reported. Anchored; matched against the first word of a finding.
KEEP_BUILTIN='^(CDKToolkit|CostStack|cdk-[a-z0-9]+-(assets|container-assets)-.*)$'

# ── Pure filters (unit-tested) ───────────────────────────────────────────
# findings <check> : reads the AWS CLI's JSON on stdin, prints one line per
# resource that should not be there. First word = the resource's name.
findings() {
  local prog
  case "$1" in
    eks)        prog='.clusters[]' ;;
    nat)        prog='.NatGateways[] | select(.State != "deleted") | "\(.NatGatewayId) state=\(.State)"' ;;
    elbv2)      prog='.LoadBalancers[] | "\(.LoadBalancerName) type=\(.Type)"' ;;
    elb)        prog='.LoadBalancerDescriptions[] | .LoadBalancerName' ;;
    eip)        prog='.Addresses[] | "\(.AllocationId) ip=\(.PublicIp)"' ;;
    vpce)       prog='.VpcEndpoints[] | select(.VpcEndpointType == "Interface" and .State != "deleted") | "\(.VpcEndpointId) service=\(.ServiceName)"' ;;
    instances)  prog='.Reservations[].Instances[] | select(.State.Name != "terminated") | "\(.InstanceId) state=\(.State.Name)"' ;;
    volumes)    prog='.Volumes[] | "\(.VolumeId) size=\(.Size)GiB state=\(.State)"' ;;
    snapshots)  prog='.Snapshots[] | "\(.SnapshotId) size=\(.VolumeSize)GiB"' ;;
    zones)      prog='.HostedZones[] | "\(.Name) id=\(.Id | sub("/hostedzone/"; ""))"' ;;
    # Customer keys cost $1/month until deleted. PendingDeletion is the
    # normal state after a teardown and is not charged.
    kms)        prog='.[] | .KeyMetadata | select(.KeyManager == "CUSTOMER" and .KeyState != "PendingDeletion") | "\(.KeyId) state=\(.KeyState) \(.Description // "")"' ;;
    secrets)    prog='.SecretList[] | .Name' ;;
    ecr)        prog='.repositories[] | .repositoryName' ;;
    # A stack in DELETE_COMPLETE is gone; every other state is a stack
    # that still exists, including DELETE_FAILED (the dangerous one).
    stacks)     prog='.StackSummaries[] | select(.StackStatus != "DELETE_COMPLETE") | "\(.StackName) status=\(.StackStatus)"' ;;
    vpcs)       prog='.Vpcs[] | select(.IsDefault | not) | "\(.VpcId) cidr=\(.CidrBlock)"' ;;
    enis)       prog='.NetworkInterfaces[] | "\(.NetworkInterfaceId) status=\(.Status) \(.Description // "")"' ;;
    # Input: [{Name, Project}] built by check_buckets. Only this project's
    # buckets: the account also holds other projects' buckets.
    buckets)    prog='.[] | select(.Project == "idp") | .Name' ;;
    # Prints "armed" when the budget-alarm stack is deployed and healthy.
    guardrail)  prog='[.StackSummaries[] | select(.StackName == "CostStack" and (.StackStatus | test("^(CREATE|UPDATE)_COMPLETE$")))] | if length > 0 then "armed" else empty end' ;;
    roles)      prog='.Roles[] | select(.RoleName | test("^(idp-|(Vpc|Kms|Iam|Cluster|Registry|Dns)Stack-)")) | .RoleName' ;;
    policies)   prog='.Policies[] | select(.PolicyName | startswith("idp-")) | .PolicyName' ;;
    oidc)       prog='.OpenIDConnectProviderList[] | .Arn | select(test("oidc-provider/oidc\\.eks\\.")) | sub("^.*oidc-provider/"; "")' ;;
    loggroups)  prog='.logGroups[] | select(.logGroupName | test("^/aws/(eks|containerinsights)/|idp")) | "\(.logGroupName) bytes=\(.storedBytes // 0)"' ;;
    # Catch-all: anything still carrying the project tag. The tagging API
    # can list a resource for a while after it is deleted, so this is
    # only ever a warning. Budgets and everything CostStack owns (alarms,
    # the teardown timer) are kept on purpose.
    tagged)     prog='.ResourceTagMappingList[] | .ResourceARN | select(test("CostStack|:budgets:|:ce:") | not)' ;;
    *) echo "unknown check: $1" >&2; return 2 ;;
  esac
  jq -r "$prog"
}

# drop_kept <extra-regex> : removes findings whose first word is kept.
drop_kept() {
  awk -v builtin="$KEEP_BUILTIN" -v extra="${1:-}" \
    '{ if ($1 ~ builtin) next; if (extra != "" && $1 ~ extra) next; print }'
}

# ── Talking to AWS ───────────────────────────────────────────────────────

# report <BILLS|LEFT> <title> <findings text> <rc of the AWS call>
report() {
  local sev="$1" title="$2" items="$3" rc="$4" n
  if [[ "$rc" -ne 0 ]]; then
    printf '%s  ERROR%s  %s: could not check (counts as a failure)\n' "$RED" "$RESET" "$title"
    ERRORS=$((ERRORS + 1)); return
  fi
  if [[ -z "$items" ]]; then
    printf '%s  none %s  %s\n' "$GREEN" "$RESET" "$title"; return
  fi
  n=$(wc -l <<<"$items" | tr -d ' ')
  if [[ "$sev" == "BILLS" ]]; then
    printf '%s  BILLS%s  %s: %s\n' "$RED" "$RESET" "$title" "$n"; BILLS=$((BILLS + n))
  else
    printf '%s  LEFT %s  %s: %s\n' "$YELLOW" "$RESET" "$title" "$n"; LEFT=$((LEFT + n))
  fi
  while IFS= read -r n; do printf '           %s\n' "$n"; done <<<"$items"
}

# check <BILLS|LEFT> <title> <filter> <aws args...>
check() {
  local sev="$1" title="$2" filter="$3" json items rc=0
  shift 3
  json=$(aws "$@" --output json 2>/dev/null) || rc=$?
  items=""
  if [[ $rc -eq 0 ]]; then
    items=$(findings "$filter" <<<"$json" | drop_kept "${AUDIT_KEEP:-}") || rc=$?
  fi
  report "$sev" "$title" "$items" "$rc"
}

# KMS has no single call that returns key state, so describe each key.
check_kms() {
  local region="$1" ids id json="" one rc=0 items=""
  ids=$(aws kms list-keys --region "$region" --query 'Keys[].KeyId' --output text 2>/dev/null) || rc=$?
  if [[ $rc -eq 0 ]]; then
    for id in $ids; do
      one=$(aws kms describe-key --region "$region" --key-id "$id" --output json 2>/dev/null) || { rc=1; break; }
      json+="$one"$'\n'
    done
  fi
  if [[ $rc -eq 0 ]]; then
    items=$(jq -s '.' <<<"$json" | findings kms | drop_kept "${AUDIT_KEEP:-}") || rc=$?
  fi
  report BILLS "[$region] customer KMS keys (\$1/month each)" "$items" "$rc"
}

# S3 has no "list buckets by tag", and this account holds other projects'
# buckets, so read each bucket's Project tag. A bucket with no tags at all
# (NoSuchTagSet) is not ours; any other error means we could not look.
check_buckets() {
  local names name tag err json="" rc=0 items=""
  names=$(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null) || rc=$?
  if [[ $rc -eq 0 ]]; then
    for name in $names; do
      if tag=$(aws s3api get-bucket-tagging --bucket "$name" \
        --query "TagSet[?Key=='Project']|[0].Value" --output text 2>"$ERRFILE"); then
        :
      else
        err=$(cat "$ERRFILE")
        if [[ "$err" == *NoSuchTagSet* ]]; then tag="None"; else rc=1; break; fi
      fi
      json+=$(jq -n --arg n "$name" --arg p "$tag" '{Name: $n, Project: $p}')$'\n'
    done
  fi
  if [[ $rc -eq 0 ]]; then
    items=$(jq -s '.' <<<"$json" | findings buckets | drop_kept "${AUDIT_KEEP:-}") || rc=$?
  fi
  report LEFT "[global] S3 buckets tagged Project=idp" "$items" "$rc"
}

# The opposite kind of check: something that SHOULD be there.
check_guardrail() {
  local r="$1" json
  if json=$(aws cloudformation list-stacks --region "$r" --output json 2>/dev/null) &&
    [[ "$(findings guardrail <<<"$json")" == "armed" ]]; then
    printf '%s  armed%s  [%s] budget alarms (CostStack)\n' "$GREEN" "$RESET" "$r"
  else
    printf '%s  ERROR%s  [%s] budget alarms (CostStack) are NOT deployed: nothing would warn you about spend\n' "$RED" "$RESET" "$r"
    ERRORS=$((ERRORS + 1))
  fi
}

audit_region() {
  local r="$1"
  check BILLS "[$r] EKS clusters (\$0.10/h and up)"      eks       eks list-clusters --region "$r"
  check BILLS "[$r] NAT gateways (\$0.05/h)"             nat       ec2 describe-nat-gateways --region "$r"
  check BILLS "[$r] load balancers (\$0.03/h)"           elbv2     elbv2 describe-load-balancers --region "$r"
  check BILLS "[$r] classic load balancers"             elb       elb describe-load-balancers --region "$r"
  check BILLS "[$r] Elastic IPs (\$0.005/h)"             eip       ec2 describe-addresses --region "$r"
  check BILLS "[$r] interface VPC endpoints (\$0.01/h per AZ)" vpce ec2 describe-vpc-endpoints --region "$r"
  check BILLS "[$r] EC2 instances"                      instances ec2 describe-instances --region "$r"
  check BILLS "[$r] EBS volumes"                        volumes   ec2 describe-volumes --region "$r"
  check BILLS "[$r] EBS snapshots"                      snapshots ec2 describe-snapshots --owner-ids self --region "$r"
  check_kms "$r"
  check BILLS "[$r] Secrets Manager secrets (\$0.40/month each)" secrets secretsmanager list-secrets --region "$r"
  check BILLS "[$r] ECR repositories (storage)"         ecr       ecr describe-repositories --region "$r"
  check LEFT  "[$r] CloudFormation stacks"              stacks    cloudformation list-stacks --region "$r"
  check LEFT  "[$r] non-default VPCs"                   vpcs      ec2 describe-vpcs --region "$r"
  check LEFT  "[$r] network interfaces"                 enis      ec2 describe-network-interfaces --region "$r"
  check LEFT  "[$r] log groups"                         loggroups logs describe-log-groups --region "$r"
  check LEFT  "[$r] anything tagged Project=idp"        tagged    resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=idp --region "$r"
}

audit_global() {
  check BILLS "[global] Route 53 hosted zones (\$0.50/month each)" zones route53 list-hosted-zones
  check_buckets
  check LEFT  "[global] IAM roles from this project"    roles     iam list-roles
  check LEFT  "[global] IAM policies from this project" policies  iam list-policies --scope Local
  check LEFT  "[global] EKS OIDC providers"             oidc      iam list-open-id-connect-providers
}

main() {
  local strict=0 r
  [[ "${1:-}" == "--strict" ]] && strict=1
  : "${AWS_REGION:?set AWS_REGION}"
  for r in aws jq; do
    command -v "$r" >/dev/null 2>&1 || { echo "required tool not found: $r" >&2; exit 1; }
  done
  aws sts get-caller-identity >/dev/null 2>&1 || { echo "AWS credentials not working; nothing was checked" >&2; exit 1; }

  printf 'AWS audit (read-only). Regions: %s %s\n' "$AWS_REGION" "${AUDIT_REGIONS:-}"
  ERRFILE=$(mktemp "${TMPDIR:-/tmp}/aws-audit.XXXXXX")
  trap 'rm -f "${ERRFILE:?}"' EXIT
  check_guardrail "$AWS_REGION"
  for r in $AWS_REGION ${AUDIT_REGIONS:-}; do audit_region "$r"; done
  audit_global

  printf '\n'
  if (( ERRORS > 0 )); then
    printf '%sAudit FAILED: %d check(s) could not run or found a missing guardrail. Treat as not clean.%s\n' "$RED" "$ERRORS" "$RESET"; exit 1
  fi
  if (( BILLS > 0 )); then
    printf '%sNOT CLEAN: %d resource(s) still billing, %d free leftover(s).%s\n' "$RED" "$BILLS" "$LEFT" "$RESET"; exit 1
  fi
  if (( LEFT > 0 )); then
    printf '%sNothing is billing. %d free leftover(s) to clean up.%s\n' "$YELLOW" "$LEFT" "$RESET"
    (( strict )) && exit 1
    exit 0
  fi
  printf '%sClean: nothing billing, nothing left over.%s\n' "$GREEN" "$RESET"
}

# Run only when executed, not when sourced by the tests.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

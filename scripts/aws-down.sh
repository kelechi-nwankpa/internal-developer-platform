#!/usr/bin/env bash
# aws-down.sh — tear the AWS session down in an order that actually works,
# then prove it with the audit. Run: make aws-down   (or: make aws-down-plan)
#
# WHY an order is needed: `cdk destroy` removes what CloudFormation
# created. During a session the cluster's controllers create more, which
# CloudFormation has never heard of:
#   - a load balancer            (the Gateway's Service)
#   - S3 buckets, IAM roles      (Crossplane, one set per ObjectBucket)
#   - DNS records                (external-dns, cert-manager DNS-01)
#   - a log group                (EKS itself; this one survived Phase 1)
# Left in place they keep billing, and some block the destroy: a VPC with
# a load balancer in it, or a hosted zone with extra records, cannot be
# deleted, and the stack ends in DELETE_FAILED with the bill still running.
#
# THE ORDER:
#   1. destroy ClusterStack   every controller dies with the cluster, so
#                             nothing can recreate what step 2 removes
#   2. sweep                  delete what the controllers left, straight
#                             from AWS (repeat until nothing is left)
#   3. destroy the rest       VPC, DNS zone, KMS, IAM, registry
#   4. audit                  scripts/aws-audit.sh decides the exit code
#
# WHY no kubectl ("delete the claims and let the controllers clean up"):
#   - if kubectl pointed at kind, "delete all buckets" would wipe the
#     local platform;
#   - teardown matters most when the cluster is broken and cannot answer.
# The sweep needs only AWS credentials and works on a dead cluster.
#
# SAFETY: the account is shared with other projects. The sweep may only
# touch things provably ours:
#   - load balancers, target groups, network interfaces, security groups:
#     inside a VPC tagged Project=idp
#   - DNS records: inside the zone named ZONE_NAME
#   - buckets, IAM roles, IAM policies: tagged Project=idp, re-checked
#     immediately before each delete (roles/policies also need the idp-
#     name prefix)
#   - log groups: under /aws/eks/<CLUSTER_NAME>/
# `--plan` prints what the sweep would delete and changes nothing.
#
# Configuration (from the Makefile):
#   AWS_REGION  CDK_DIR  WORKLOAD_STACKS  ZONE_NAME  CLUSTER_NAME
#
# The plan_* functions are pure (JSON in, commands out) and unit-tested
# by scripts/tests/aws-down.test.sh, which sources this file.

set -uo pipefail

RED=$'\033[1;31m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[1;34m'; RESET=$'\033[0m'
SWEEP_ROUNDS="${SWEEP_ROUNDS:-4}"
SWEEP_WAIT="${SWEEP_WAIT:-45}" # seconds between rounds: AWS frees network interfaces slowly

say() { printf '%s==> %s%s\n' "$BLUE" "$1" "$RESET"; }

# ── Pure planners (unit-tested) ──────────────────────────────────────────
# Each reads one AWS CLI JSON response on stdin and prints one command per
# resource to delete. A line starting with `aws` is run as is; any other
# first word is a function in this file (multi-step deletes).

# plan <kind> [args...]
plan() {
  local kind="$1"; shift
  case "$kind" in
    # args: region, JSON array of project VPC ids
    lbs)
      jq -r --arg r "$1" --argjson vpcs "$2" '.LoadBalancers[] | select(.VpcId as $v | $vpcs | index($v))
        | "aws elbv2 delete-load-balancer --region \($r) --load-balancer-arn \(.LoadBalancerArn)"' ;;
    tgs)
      jq -r --arg r "$1" --argjson vpcs "$2" '.TargetGroups[] | select(.VpcId as $v | $vpcs | index($v))
        | "aws elbv2 delete-target-group --region \($r) --target-group-arn \(.TargetGroupArn)"' ;;
    # Only interfaces nobody is using; an in-use one belongs to something
    # that must be deleted first (and AWS would refuse anyway).
    enis)
      jq -r --arg r "$1" --argjson vpcs "$2" '.NetworkInterfaces[] | select(.Status == "available")
        | select(.VpcId as $v | $vpcs | index($v))
        | "aws ec2 delete-network-interface --region \($r) --network-interface-id \(.NetworkInterfaceId)"' ;;
    # Security groups CloudFormation made carry its stack tag and are left
    # to step 3. The rest were made by controllers and block VPC deletion.
    sgs)
      jq -r --arg r "$1" --argjson vpcs "$2" '.SecurityGroups[] | select(.GroupName != "default")
        | select(.VpcId as $v | $vpcs | index($v))
        | select((.Tags // []) | any(.Key == "aws:cloudformation:stack-name") | not)
        | "aws ec2 delete-security-group --region \($r) --group-id \(.GroupId)"' ;;
    # args: zone id, zone name (with trailing dot). The zone's own NS and
    # SOA records cannot be deleted and go with the zone.
    records)
      jq -r --arg id "$1" --arg zone "$2" '.ResourceRecordSets[]
        | select(((.Type == "NS" or .Type == "SOA") and .Name == $zone) | not)
        | "delete_record \($id) \(tojson)"' ;;
    # input: [{Name, Project}] (see bucket_tags)
    buckets)  jq -r '.[] | select(.Project == "idp") | "delete_bucket \(.Name)"' ;;
    roles)    jq -r '.Roles[] | select(.RoleName | startswith("idp-")) | "delete_role \(.RoleName)"' ;;
    policies) jq -r '.Policies[] | select(.PolicyName | startswith("idp-")) | "delete_policy \(.Arn)"' ;;
    # args: region, cluster name
    loggroups)
      jq -r --arg r "$1" --arg c "$2" '.logGroups[] | select(.logGroupName | startswith("/aws/eks/" + $c + "/"))
        | "aws logs delete-log-group --region \($r) --log-group-name \(.logGroupName)"' ;;
    # args: zone name without trailing dot → prints the zone id, if any
    zone_id)
      jq -r --arg z "$1." '.HostedZones[] | select(.Name == $z) | .Id | sub("/hostedzone/"; "")' ;;
    *) echo "unknown plan kind: $kind" >&2; return 2 ;;
  esac
}

# ── Reading AWS (no changes) ─────────────────────────────────────────────

# Prints [{Name, Project}] for every bucket. NoSuchTagSet = untagged = not ours.
bucket_tags() {
  local names name tag err
  names=$(aws s3api list-buckets --query 'Buckets[].Name' --output text) || return 1
  for name in $names; do
    if ! tag=$(aws s3api get-bucket-tagging --bucket "$name" \
      --query "TagSet[?Key=='Project']|[0].Value" --output text 2>&1); then
      err="$tag"
      [[ "$err" == *NoSuchTagSet* ]] || { echo "cannot read tags of bucket $name" >&2; return 1; }
      tag="None"
    fi
    jq -n --arg n "$name" --arg p "$tag" '{Name: $n, Project: $p}'
  done | jq -s '.'
}

# Prints the full sweep plan, in the order it must run. Returns non-zero
# if any listing failed (an incomplete plan must not look like "nothing").
gather_plan() {
  local r="$AWS_REGION" vpcs zone rc=0 j
  vpcs=$(aws ec2 describe-vpcs --region "$r" --filters Name=tag:Project,Values=idp \
    --query 'Vpcs[].VpcId' --output json) || return 1

  # Network: load balancers first; their interfaces and groups free up after.
  j=$(aws elbv2 describe-load-balancers --region "$r" --output json) && plan lbs "$r" "$vpcs" <<<"$j" || rc=1
  j=$(aws elbv2 describe-target-groups --region "$r" --output json) && plan tgs "$r" "$vpcs" <<<"$j" || rc=1
  j=$(aws ec2 describe-network-interfaces --region "$r" --output json) && plan enis "$r" "$vpcs" <<<"$j" || rc=1
  j=$(aws ec2 describe-security-groups --region "$r" --output json) && plan sgs "$r" "$vpcs" <<<"$j" || rc=1

  # DNS records in the project zone (the zone itself goes in step 3).
  j=$(aws route53 list-hosted-zones --output json) || rc=1
  for zone in $(plan zone_id "$ZONE_NAME" <<<"${j:-{\}}"); do
    j=$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" --output json) &&
      plan records "$zone" "$ZONE_NAME." <<<"$j" || rc=1
  done

  # What Crossplane made. Roles before policies: a policy cannot be
  # deleted while attached.
  j=$(bucket_tags) && plan buckets <<<"$j" || rc=1
  j=$(aws iam list-roles --output json) && plan roles <<<"$j" || rc=1
  j=$(aws iam list-policies --scope Local --output json) && plan policies <<<"$j" || rc=1

  j=$(aws logs describe-log-groups --region "$r" --output json) && plan loggroups "$r" "$CLUSTER_NAME" <<<"$j" || rc=1
  return $rc
}

# ── Multi-step deletes (each re-checks ownership first) ──────────────────

delete_record() { # <zone id> <record set JSON>
  local zone="$1"; shift
  aws route53 change-resource-record-sets --hosted-zone-id "$zone" \
    --change-batch "$(jq -cn --argjson rr "$*" '{Changes: [{Action: "DELETE", ResourceRecordSet: $rr}]}')" >/dev/null
}

delete_bucket() { # <name>   empties every version, then deletes
  local b="$1" tag page objs
  tag=$(aws s3api get-bucket-tagging --bucket "$b" --query "TagSet[?Key=='Project']|[0].Value" --output text 2>/dev/null)
  [[ "$tag" == "idp" ]] || { echo "refusing: bucket $b is not tagged Project=idp" >&2; return 1; }
  # A versioned bucket keeps old versions and delete markers; `s3 rm`
  # leaves them and the bucket then cannot be deleted.
  while :; do
    page=$(aws s3api list-object-versions --bucket "$b" --max-items 500 --output json) || return 1
    objs=$(jq -c '[(.Versions // [])[], (.DeleteMarkers // [])[] | {Key, VersionId}]' <<<"${page:-{\}}")
    [[ "$objs" == "[]" ]] && break
    aws s3api delete-objects --bucket "$b" --delete "$(jq -c '{Objects: ., Quiet: true}' <<<"$objs")" >/dev/null || return 1
  done
  aws s3api delete-bucket --bucket "$b"
}

delete_role() { # <name>
  local role="$1" tag arn pol
  [[ "$role" == idp-* ]] || { echo "refusing: role $role has no idp- prefix" >&2; return 1; }
  tag=$(aws iam get-role --role-name "$role" --query "Role.Tags[?Key=='Project']|[0].Value" --output text 2>/dev/null)
  [[ "$tag" == "idp" ]] || { echo "refusing: role $role is not tagged Project=idp" >&2; return 1; }
  for arn in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" || return 1
  done
  for pol in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$pol" || return 1
  done
  aws iam delete-role --role-name "$role"
}

delete_policy() { # <arn>
  local arn="$1" tag
  [[ "$arn" == *":policy/idp-"* ]] || { echo "refusing: policy $arn has no idp- prefix" >&2; return 1; }
  tag=$(aws iam get-policy --policy-arn "$arn" --query "Policy.Tags[?Key=='Project']|[0].Value" --output text 2>/dev/null)
  [[ "$tag" == "idp" ]] || { echo "refusing: policy $arn is not tagged Project=idp" >&2; return 1; }
  aws iam delete-policy --policy-arn "$arn"
}

# Runs one plan line. Only the verbs below can run; anything else is refused.
run_line() {
  local verb="${1%% *}" rest="${1#* }" words
  case "$verb" in
    aws)
      # Planner output: plain words separated by single spaces.
      read -r -a words <<<"$rest"
      aws "${words[@]}" >/dev/null ;;
    delete_record) delete_record "${rest%% *}" "${rest#* }" ;;
    delete_bucket | delete_role | delete_policy) "$verb" "$rest" ;;
    *) echo "refusing unknown plan verb: $verb" >&2; return 1 ;;
  esac
}

# Sweeps until a round finds nothing. Returns 0 only if the last plan was
# complete AND empty.
sweep() {
  local round plan_text line
  for round in $(seq 1 "$SWEEP_ROUNDS"); do
    if ! plan_text=$(gather_plan); then
      printf '%s  could not list everything; sweep is incomplete%s\n' "$RED" "$RESET"
      return 1
    fi
    if [[ -z "$plan_text" ]]; then
      printf '%s  sweep: nothing left%s\n' "$GREEN" "$RESET"; return 0
    fi
    say "sweep round $round: $(wc -l <<<"$plan_text" | tr -d ' ') item(s)"
    while IFS= read -r line; do
      printf '  %s\n' "${line:0:150}"
      run_line "$line" || { printf '%s    failed (will retry next round)%s\n' "$YELLOW" "$RESET"; }
    done <<<"$plan_text"
    [[ "$round" -lt "$SWEEP_ROUNDS" ]] && sleep "$SWEEP_WAIT"
  done
  printf '%s  sweep: still not empty after %s rounds%s\n' "$RED" "$SWEEP_ROUNDS" "$RESET"
  return 1
}

destroy() { # <stack names...>
  (cd "$CDK_DIR" && AWS_REGION="$AWS_REGION" npx cdk destroy "$@" --force)
}

main() {
  local mode="run" problems=0 stacks
  case "${1:-}" in
    --plan) mode="plan" ;;
    --yes) mode="yes" ;;
    "") ;;
    *) echo "usage: aws-down.sh [--plan|--yes]" >&2; exit 2 ;;
  esac
  : "${AWS_REGION:?set AWS_REGION}" "${CDK_DIR:?set CDK_DIR}" "${WORKLOAD_STACKS:?set WORKLOAD_STACKS}"
  : "${ZONE_NAME:?set ZONE_NAME}" "${CLUSTER_NAME:?set CLUSTER_NAME}"
  local t
  for t in aws jq npx; do
    command -v "$t" >/dev/null 2>&1 || { echo "required tool not found: $t" >&2; exit 1; }
  done
  aws sts get-caller-identity >/dev/null 2>&1 || { echo "AWS credentials not working; nothing was done" >&2; exit 1; }

  if [[ "$mode" == "plan" ]]; then
    say "what the sweep would delete right now (nothing is changed)"
    local p rc=0
    p=$(gather_plan) || rc=1
    if [[ -n "$p" ]]; then
      while IFS= read -r t; do printf '  %s\n' "${t:0:150}"; done <<<"$p"
    else
      echo "  nothing"
    fi
    [[ $rc -eq 0 ]] || { printf '%s  some listings failed; this plan is incomplete%s\n' "$RED" "$RESET"; exit 1; }
    exit 0
  fi

  if [[ "$mode" != "yes" ]]; then
    printf '%sThis destroys: %s\n' "$YELLOW" "$WORKLOAD_STACKS"
    printf 'and everything the cluster created (load balancer, buckets and their data, IAM roles, DNS records).\n'
    printf 'CostStack stays (budget alarms). KMS keys enter a 7-day deletion window.\nContinue? [y/N] %s' "$RESET"
    read -r t; [[ "$t" == "y" ]] || { echo "Aborted. Nothing was changed."; exit 1; }
  fi

  say "1/4 destroy ClusterStack (stops every controller)"
  destroy ClusterStack || { printf '%s  ClusterStack destroy failed; continuing so the sweep can unblock it%s\n' "$YELLOW" "$RESET"; }

  say "2/4 sweep what the controllers left"
  sweep || problems=1

  say "3/4 destroy the remaining stacks"
  read -r -a stacks <<<"$WORKLOAD_STACKS"
  if ! destroy "${stacks[@]}"; then
    printf '%s  destroy failed; sweeping once more and retrying%s\n' "$YELLOW" "$RESET"
    sweep || problems=1
    destroy "${stacks[@]}" || problems=1
  fi

  say "4/4 audit"
  if AWS_REGION="$AWS_REGION" "$(dirname "$0")/aws-audit.sh" && [[ $problems -eq 0 ]]; then
    printf '%sTeardown complete and verified.%s\n' "$GREEN" "$RESET"
  else
    printf '%sTEARDOWN NOT VERIFIED. Read the audit above; something may still be billing.%s\n' "$RED" "$RESET"
    exit 1
  fi
}

# Run only when executed, not when sourced by the tests.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

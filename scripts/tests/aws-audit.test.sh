#!/usr/bin/env bash
# Unit tests for scripts/aws-audit.sh. No AWS calls.
# Run: make audit-test   (or: bash scripts/tests/aws-audit.test.sh)
#
# Part 1 feeds example AWS responses to the pure filters. Every rule is
# tested in both directions (something to report / nothing to report) so
# the tests can actually fail.
# Part 2 runs the whole script against a fake `aws` command to check the
# exit codes, above all that a check which cannot run is a failure.

set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/aws-audit.sh
source "$HERE/../aws-audit.sh"

PASSED=0; FAILED=0
expect() { # expect <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"
  else FAILED=$((FAILED + 1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}
f() { findings "$1" <<<"$2" | drop_kept "${3:-}"; }

echo "billing resources"
expect "a running cluster is reported" "idp" "$(f eks '{"clusters":["idp"]}')"
expect "no clusters → nothing" "" "$(f eks '{"clusters":[]}')"
expect "NAT gateway still deleting is reported, deleted is not" "nat-1 state=deleting" \
  "$(f nat '{"NatGateways":[{"NatGatewayId":"nat-1","State":"deleting"},{"NatGatewayId":"nat-2","State":"deleted"}]}')"
expect "load balancer made by Kubernetes is reported" "k8s-gateway-abc type=network" \
  "$(f elbv2 '{"LoadBalancers":[{"LoadBalancerName":"k8s-gateway-abc","Type":"network"}]}')"
expect "only INTERFACE endpoints bill; gateway endpoints are free" "vpce-1 service=com.amazonaws.eu-west-1.ecr.api" \
  "$(f vpce '{"VpcEndpoints":[{"VpcEndpointId":"vpce-1","VpcEndpointType":"Interface","State":"available","ServiceName":"com.amazonaws.eu-west-1.ecr.api"},{"VpcEndpointId":"vpce-2","VpcEndpointType":"Gateway","State":"available","ServiceName":"com.amazonaws.eu-west-1.s3"}]}')"
expect "terminated instance is not reported, stopped one is (its disk bills)" "i-2 state=stopped" \
  "$(f instances '{"Reservations":[{"Instances":[{"InstanceId":"i-1","State":{"Name":"terminated"}},{"InstanceId":"i-2","State":{"Name":"stopped"}}]}]}')"
expect "hosted zone is reported with its id" "idp.seniormankelz.dev. id=Z123" \
  "$(f zones '{"HostedZones":[{"Name":"idp.seniormankelz.dev.","Id":"/hostedzone/Z123"}]}')"
expect "a zone kept on purpose (AUDIT_KEEP) is not reported" "" \
  "$(f zones '{"HostedZones":[{"Name":"seniormankelz.dev.","Id":"/hostedzone/Z9"}]}' '^seniormankelz\.dev\.$')"
expect "AUDIT_KEEP for the parent zone does not hide the project zone" "idp.seniormankelz.dev. id=Z123" \
  "$(f zones '{"HostedZones":[{"Name":"idp.seniormankelz.dev.","Id":"/hostedzone/Z123"}]}' '^seniormankelz\.dev\.$')"

echo "KMS keys"
KMS='[{"KeyMetadata":{"KeyId":"k-enabled","KeyManager":"CUSTOMER","KeyState":"Enabled","Description":"eks secrets"}},
      {"KeyMetadata":{"KeyId":"k-pending","KeyManager":"CUSTOMER","KeyState":"PendingDeletion"}},
      {"KeyMetadata":{"KeyId":"k-aws","KeyManager":"AWS","KeyState":"Enabled"}},
      {"KeyMetadata":{"KeyId":"k-disabled","KeyManager":"CUSTOMER","KeyState":"Disabled"}}]'
expect "enabled and disabled customer keys bill; pending-deletion and AWS-managed do not" \
  "k-enabled state=Enabled eks secrets"$'\n'"k-disabled state=Disabled " "$(f kms "$KMS")"

echo "CloudFormation stacks"
STACKS='{"StackSummaries":[{"StackName":"CostStack","StackStatus":"CREATE_COMPLETE"},
  {"StackName":"CDKToolkit","StackStatus":"CREATE_COMPLETE"},
  {"StackName":"VpcStack","StackStatus":"DELETE_FAILED"},
  {"StackName":"ClusterStack","StackStatus":"DELETE_COMPLETE"},
  {"StackName":"DnsStack","StackStatus":"DELETE_IN_PROGRESS"}]}'
expect "DELETE_FAILED and in-progress are reported; DELETE_COMPLETE, CostStack, CDKToolkit are not" \
  "VpcStack status=DELETE_FAILED"$'\n'"DnsStack status=DELETE_IN_PROGRESS" "$(f stacks "$STACKS")"
expect "guardrail: CostStack healthy → armed" "armed" "$(findings guardrail <<<"$STACKS")"
expect "guardrail: CostStack deleted → not armed" "" \
  "$(findings guardrail <<<'{"StackSummaries":[{"StackName":"CostStack","StackStatus":"DELETE_COMPLETE"}]}')"
expect "guardrail: CostStack rolled back → not armed" "" \
  "$(findings guardrail <<<'{"StackSummaries":[{"StackName":"CostStack","StackStatus":"ROLLBACK_COMPLETE"}]}')"

echo "this project's leftovers only"
expect "only buckets tagged Project=idp; other projects' buckets are ignored" "platform-hello-x7k2p-3f9a1c" \
  "$(f buckets '[{"Name":"platform-hello-x7k2p-3f9a1c","Project":"idp"},{"Name":"someone-elses-bucket","Project":"None"},{"Name":"other-project","Project":"shop"}]')"
expect "IAM roles: Crossplane's idp- roles and stack roles, not unrelated ones" \
  "idp-platform-hello-x7k2p-3f9a1c"$'\n'"ClusterStack-ClusterRole-ABC" \
  "$(f roles '{"Roles":[{"RoleName":"idp-platform-hello-x7k2p-3f9a1c"},{"RoleName":"ClusterStack-ClusterRole-ABC"},{"RoleName":"AWSServiceRoleForSupport"},{"RoleName":"my-idp-unrelated"}]}')"
expect "IAM policies with the idp- prefix" "idp-platform-hello-x7k2p-3f9a1c" \
  "$(f policies '{"Policies":[{"PolicyName":"idp-platform-hello-x7k2p-3f9a1c"},{"PolicyName":"other"}]}')"
expect "EKS OIDC provider left behind; GitHub's OIDC provider is not ours to report" \
  "oidc.eks.eu-west-1.amazonaws.com/id/ABC" \
  "$(f oidc '{"OpenIDConnectProviderList":[{"Arn":"arn:aws:iam::111122223333:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/ABC"},{"Arn":"arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"}]}')"
expect "EKS log group is reported; another project's is not" "/aws/eks/idp/cluster bytes=133917649" \
  "$(f loggroups '{"logGroups":[{"logGroupName":"/aws/eks/idp/cluster","storedBytes":133917649},{"logGroupName":"/aws/lambda/shop-checkout","storedBytes":5}]}')"
expect "tag catch-all ignores CostStack and budgets, reports the rest" \
  "arn:aws:ec2:eu-west-1:111122223333:security-group/sg-1" \
  "$(f tagged '{"ResourceTagMappingList":[{"ResourceARN":"arn:aws:cloudformation:eu-west-1:111122223333:stack/CostStack/abc"},{"ResourceARN":"arn:aws:budgets::111122223333:budget/idp-5usd-actual"},{"ResourceARN":"arn:aws:ec2:eu-west-1:111122223333:security-group/sg-1"}]}')"
expect "the teardown timer's own resources (in CostStack) are kept, not reported" "" \
  "$(f tagged '{"ResourceTagMappingList":[{"ResourceARN":"arn:aws:lambda:eu-west-1:111122223333:function:CostStack-TeardownTimerFn-ABC"},{"ResourceARN":"arn:aws:sns:eu-west-1:111122223333:CostStack-TeardownTimerTopic-ABC"},{"ResourceARN":"arn:aws:logs:eu-west-1:111122223333:log-group:CostStack-TeardownTimerLogs-ABC"}]}')"
expect "CDK bootstrap bucket and repository are never reported" "" \
  "$(printf '%s\n' cdk-hnb659fds-assets-111122223333-eu-west-1 cdk-hnb659fds-container-assets-111122223333-eu-west-1 | drop_kept "")"
expect "a name that merely starts with cdk- is still reported" "cdk-demo-bucket" "$(echo cdk-demo-bucket | drop_kept "")"
expect "unknown check name is an error, not silence" "2" "$(findings nonsense <<<'{}' >/dev/null 2>&1; echo $?)"

# ── Part 2: whole script against a fake `aws` ────────────────────────────
echo "exit codes (fake aws)"
FAKE=$(mktemp -d "${TMPDIR:-/tmp}/aws-audit-test.XXXXXX")
trap 'rm -rf "${FAKE:?}"' EXIT
# The fake answers every call with an empty account, except what the
# FAKE_* variables say. Unknown calls return {} (jq then finds nothing).
cat >"$FAKE/aws" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "sts get-caller-identity"*) echo '{}' ;;
  "cloudformation list-stacks"*)
    if [[ "${FAKE_NO_GUARDRAIL:-}" == 1 ]]; then echo '{"StackSummaries":[]}'
    else echo '{"StackSummaries":[{"StackName":"CostStack","StackStatus":"CREATE_COMPLETE"}]}'; fi ;;
  "eks list-clusters"*)
    if [[ "${FAKE_CLUSTER:-}" == 1 ]]; then echo '{"clusters":["idp"]}'; else echo '{"clusters":[]}'; fi ;;
  "ec2 describe-nat-gateways"*)
    if [[ "${FAKE_BROKEN_CALL:-}" == 1 ]]; then echo "AccessDenied" >&2; exit 254; fi
    echo '{"NatGateways":[]}' ;;
  "logs describe-log-groups"*)
    if [[ "${FAKE_LOGGROUP:-}" == 1 ]]; then echo '{"logGroups":[{"logGroupName":"/aws/eks/idp/cluster","storedBytes":1}]}'
    else echo '{"logGroups":[]}'; fi ;;
  "kms list-keys"*|"s3api list-buckets --query"*) echo "" ;;
  "ec2 describe-load-balancers"*) echo '{}' ;;
  *) echo '{"clusters":[],"NatGateways":[],"LoadBalancers":[],"LoadBalancerDescriptions":[],"Addresses":[],"VpcEndpoints":[],"Reservations":[],"Volumes":[],"Snapshots":[],"SecretList":[],"repositories":[],"Vpcs":[],"NetworkInterfaces":[],"ResourceTagMappingList":[],"HostedZones":[],"Roles":[],"Policies":[],"OpenIDConnectProviderList":[]}' ;;
esac
EOF
chmod +x "$FAKE/aws"
run() { # run <env assignments...> -- prints "<exit code> <last line, colours stripped>"
  local out rc
  out=$(env PATH="$FAKE:$PATH" AWS_REGION=eu-west-1 "$@" bash "$HERE/../aws-audit.sh" ${STRICT:+--strict} 2>&1); rc=$?
  printf '%s %s' "$rc" "$(tail -1 <<<"$out" | sed $'s/\033\\[[0-9;]*m//g')"
}
expect "empty account → clean, exit 0" "0 Clean: nothing billing, nothing left over." "$(run FAKE_X=0)"
expect "a running cluster → exit 1" "1 NOT CLEAN: 1 resource(s) still billing, 0 free leftover(s)." "$(run FAKE_CLUSTER=1)"
expect "a free leftover → warning, exit 0" "0 Nothing is billing. 1 free leftover(s) to clean up." "$(run FAKE_LOGGROUP=1)"
expect "a free leftover with --strict → exit 1" "1 Nothing is billing. 1 free leftover(s) to clean up." "$(STRICT=1 run FAKE_LOGGROUP=1)"
expect "one AWS call fails → exit 1, never 'clean'" \
  "1 Audit FAILED: 1 check(s) could not run or found a missing guardrail. Treat as not clean." "$(run FAKE_BROKEN_CALL=1)"
expect "budget alarms missing → exit 1" \
  "1 Audit FAILED: 1 check(s) could not run or found a missing guardrail. Treat as not clean." "$(run FAKE_NO_GUARDRAIL=1)"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))

#!/usr/bin/env bash
# Unit tests for scripts/aws-down.sh. No AWS calls, nothing is deleted.
# Run: make down-test   (or: bash scripts/tests/aws-down.test.sh)
#
# Part 1: the planners. Every example response mixes this project's
#         resources with another project's; only ours may be planned.
# Part 2: the multi-step deletes refuse anything not provably ours.
# Part 3: the whole teardown against a fake `aws` and a fake `npx cdk`
#         that record every changing call. The record must equal the
#         expected list exactly, in order.

set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/aws-down.sh
source "$HERE/../aws-down.sh"

PASSED=0; FAILED=0
expect() { # expect <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"
  else FAILED=$((FAILED + 1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}
VPCS='["vpc-ours"]'

echo "planners: only this project's resources"
expect "load balancer in our VPC is planned; another project's is not" \
  "aws elbv2 delete-load-balancer --region eu-west-1 --load-balancer-arn arn:lb/ours" \
  "$(plan lbs eu-west-1 "$VPCS" <<<'{"LoadBalancers":[{"LoadBalancerArn":"arn:lb/ours","VpcId":"vpc-ours"},{"LoadBalancerArn":"arn:lb/shop","VpcId":"vpc-shop"}]}')"
expect "no project VPC → no load balancer is planned at all" "" \
  "$(plan lbs eu-west-1 '[]' <<<'{"LoadBalancers":[{"LoadBalancerArn":"arn:lb/shop","VpcId":"vpc-shop"}]}')"
expect "target group in our VPC only" \
  "aws elbv2 delete-target-group --region eu-west-1 --target-group-arn arn:tg/ours" \
  "$(plan tgs eu-west-1 "$VPCS" <<<'{"TargetGroups":[{"TargetGroupArn":"arn:tg/ours","VpcId":"vpc-ours"},{"TargetGroupArn":"arn:tg/shop","VpcId":"vpc-shop"}]}')"
expect "network interface: ours and unused only (in-use and other VPCs are skipped)" \
  "aws ec2 delete-network-interface --region eu-west-1 --network-interface-id eni-free" \
  "$(plan enis eu-west-1 "$VPCS" <<<'{"NetworkInterfaces":[{"NetworkInterfaceId":"eni-free","Status":"available","VpcId":"vpc-ours"},{"NetworkInterfaceId":"eni-busy","Status":"in-use","VpcId":"vpc-ours"},{"NetworkInterfaceId":"eni-shop","Status":"available","VpcId":"vpc-shop"}]}')"
expect "security group: controller-made in our VPC; not default, not CloudFormation's, not other VPCs" \
  "aws ec2 delete-security-group --region eu-west-1 --group-id sg-k8s" \
  "$(plan sgs eu-west-1 "$VPCS" <<<'{"SecurityGroups":[{"GroupId":"sg-k8s","GroupName":"k8s-elb","VpcId":"vpc-ours"},{"GroupId":"sg-def","GroupName":"default","VpcId":"vpc-ours"},{"GroupId":"sg-cfn","GroupName":"x","VpcId":"vpc-ours","Tags":[{"Key":"aws:cloudformation:stack-name","Value":"VpcStack"}]},{"GroupId":"sg-shop","GroupName":"y","VpcId":"vpc-shop"}]}')"
expect "DNS: extra records are planned; the zone's own NS and SOA are not" \
  'delete_record Z1 {"Name":"platform-hello.idp.seniormankelz.dev.","Type":"A","TTL":300,"ResourceRecords":[{"Value":"1.2.3.4"}]}'$'\n''delete_record Z1 {"Name":"sub.idp.seniormankelz.dev.","Type":"NS","TTL":300}' \
  "$(plan records Z1 idp.seniormankelz.dev. <<<'{"ResourceRecordSets":[{"Name":"idp.seniormankelz.dev.","Type":"NS","TTL":172800},{"Name":"idp.seniormankelz.dev.","Type":"SOA","TTL":900},{"Name":"platform-hello.idp.seniormankelz.dev.","Type":"A","TTL":300,"ResourceRecords":[{"Value":"1.2.3.4"}]},{"Name":"sub.idp.seniormankelz.dev.","Type":"NS","TTL":300}]}')"
expect "zone lookup matches the exact name, not the parent or a sibling" "Z1" \
  "$(plan zone_id idp.seniormankelz.dev <<<'{"HostedZones":[{"Name":"seniormankelz.dev.","Id":"/hostedzone/Z0"},{"Name":"idp.seniormankelz.dev.","Id":"/hostedzone/Z1"},{"Name":"notidp.seniormankelz.dev.","Id":"/hostedzone/Z2"}]}')"
expect "buckets: tagged Project=idp only" "delete_bucket ours-bucket" \
  "$(plan buckets <<<'[{"Name":"ours-bucket","Project":"idp"},{"Name":"shop-bucket","Project":"shop"},{"Name":"untagged","Project":"None"}]')"
expect "roles: idp- prefix only" "delete_role idp-x" \
  "$(plan roles <<<'{"Roles":[{"RoleName":"idp-x"},{"RoleName":"shop-role"},{"RoleName":"my-idp-role"}]}')"
expect "policies: idp- prefix only" "delete_policy arn:aws:iam::111122223333:policy/idp-x" \
  "$(plan policies <<<'{"Policies":[{"PolicyName":"idp-x","Arn":"arn:aws:iam::111122223333:policy/idp-x"},{"PolicyName":"shop","Arn":"arn:aws:iam::111122223333:policy/shop"}]}')"
expect "log groups: this cluster's only (not another cluster whose name starts the same)" \
  "aws logs delete-log-group --region eu-west-1 --log-group-name /aws/eks/idp/cluster" \
  "$(plan loggroups eu-west-1 idp <<<'{"logGroups":[{"logGroupName":"/aws/eks/idp/cluster"},{"logGroupName":"/aws/eks/idp2/cluster"},{"logGroupName":"/aws/lambda/shop"}]}')"
expect "unknown plan kind is an error" "2" "$(plan nonsense <<<'{}' >/dev/null 2>&1; echo $?)"

# ── Fake aws + fake npx ──────────────────────────────────────────────────
FAKE=$(mktemp -d "${TMPDIR:-/tmp}/aws-down-test.XXXXXX")
trap 'rm -rf "${FAKE:?}"' EXIT
export FAKE_LOG="$FAKE/calls.log"
# The fake holds a small account: ours (vpc-ours, ours-bucket, idp-x, zone
# Z1, the EKS log group) and another project's. A resource disappears from
# the listings once its delete call is in the log. Every call that would
# change AWS is appended to the log.
cat >"$FAKE/aws" <<'EOF'
#!/usr/bin/env bash
a="$*"
done_() { grep -qF -- "$1" "$FAKE_LOG" 2>/dev/null; }
case "$a" in
  *" delete-"* | *" detach-"* | *" change-resource-record-sets "*) echo "aws ${a:0:110}" >>"$FAKE_LOG"; exit 0 ;;
esac
case "$a" in
  "sts get-caller-identity"*) echo '{}' ;;
  "ec2 describe-vpcs"*"--filters"*) if done_ "cdk destroy VpcStack"; then echo '[]'; else echo '["vpc-ours"]'; fi ;;
  "elbv2 describe-load-balancers"*)
    if done_ delete-load-balancer; then echo '{"LoadBalancers":[]}'
    else echo '{"LoadBalancers":[{"LoadBalancerArn":"arn:lb/ours","LoadBalancerName":"ours","Type":"network","VpcId":"vpc-ours"}]}'; fi ;;
  "elbv2 describe-target-groups"*) echo '{"TargetGroups":[]}' ;;
  "ec2 describe-network-interfaces"*)
    # Freed only after the load balancer is gone AND one more round passed.
    if done_ delete-network-interface; then echo '{"NetworkInterfaces":[]}'
    elif done_ delete-load-balancer; then echo '{"NetworkInterfaces":[{"NetworkInterfaceId":"eni-lb","Status":"available","VpcId":"vpc-ours"}]}'
    else echo '{"NetworkInterfaces":[{"NetworkInterfaceId":"eni-lb","Status":"in-use","VpcId":"vpc-ours"}]}'; fi
    ;;
  "ec2 describe-security-groups"*) echo '{"SecurityGroups":[]}' ;;
  "route53 list-hosted-zones"*)
    if done_ "cdk destroy VpcStack"; then echo '{"HostedZones":[]}'
    else echo '{"HostedZones":[{"Name":"idp.seniormankelz.dev.","Id":"/hostedzone/Z1"},{"Name":"shop.example.","Id":"/hostedzone/ZSHOP"}]}'; fi ;;
  "route53 list-resource-record-sets --hosted-zone-id Z1"*)
    if done_ change-resource-record-sets; then echo '{"ResourceRecordSets":[{"Name":"idp.seniormankelz.dev.","Type":"NS"}]}'
    else echo '{"ResourceRecordSets":[{"Name":"idp.seniormankelz.dev.","Type":"NS"},{"Name":"platform-hello.idp.seniormankelz.dev.","Type":"A","TTL":300}]}'; fi ;;
  "s3api list-buckets"*) if done_ "delete-bucket --bucket ours-bucket"; then echo "shop-bucket"; else echo "ours-bucket shop-bucket"; fi ;;
  "s3api get-bucket-tagging --bucket ours-bucket"*) echo "idp" ;;
  "s3api get-bucket-tagging --bucket lying-bucket"*) echo "shop" ;;
  "s3api get-bucket-tagging"*) echo "An error occurred (NoSuchTagSet)" >&2; exit 254 ;;
  "s3api list-object-versions"*)
    if done_ delete-objects; then echo '{}'
    else echo '{"Versions":[{"Key":"a.txt","VersionId":"v1"}],"DeleteMarkers":[{"Key":"b.txt","VersionId":"v2"}]}'; fi ;;
  "iam list-roles"*) if done_ "delete-role --role-name idp-x"; then echo '{"Roles":[{"RoleName":"shop-role"}]}'; else echo '{"Roles":[{"RoleName":"idp-x"},{"RoleName":"shop-role"}]}'; fi ;;
  "iam get-role --role-name idp-x"*) echo "idp" ;;
  "iam get-role"*) echo "None" ;;
  "iam list-attached-role-policies"*) echo "arn:aws:iam::111122223333:policy/idp-x" ;;
  "iam list-role-policies"*) echo "" ;;
  "iam list-policies"*) if done_ delete-policy; then echo '{"Policies":[]}'; else echo '{"Policies":[{"PolicyName":"idp-x","Arn":"arn:aws:iam::111122223333:policy/idp-x"}]}'; fi ;;
  "iam get-policy --policy-arn arn:aws:iam::111122223333:policy/idp-x"*) echo "idp" ;;
  "iam get-policy"*) echo "None" ;;
  "logs describe-log-groups"*) if done_ delete-log-group; then echo '{"logGroups":[]}'; else echo '{"logGroups":[{"logGroupName":"/aws/eks/idp/cluster","storedBytes":1}]}'; fi ;;
  "cloudformation list-stacks"*) echo '{"StackSummaries":[{"StackName":"CostStack","StackStatus":"CREATE_COMPLETE"}]}' ;;
  "kms list-keys"*) echo "" ;;
  *) echo '{"clusters":[],"NatGateways":[],"LoadBalancerDescriptions":[],"Addresses":[],"VpcEndpoints":[],"Reservations":[],"Volumes":[],"Snapshots":[],"SecretList":[],"repositories":[],"Vpcs":[],"ResourceTagMappingList":[],"OpenIDConnectProviderList":[]}' ;;
esac
EOF
cat >"$FAKE/npx" <<'EOF'
#!/usr/bin/env bash
# First "destroy everything" fails when asked to, like a VPC still in use.
if [[ "${FAKE_FIRST_DESTROY_FAILS:-}" == 1 && "$*" == *VpcStack* ]] && ! grep -q "cdk destroy VpcStack" "$FAKE_LOG" 2>/dev/null; then
  echo "npx $* (FAILED)" | sed 's/ --force//' >>"$FAKE_LOG"; exit 1
fi
echo "npx $*" | sed 's/ --force//' >>"$FAKE_LOG"
EOF
chmod +x "$FAKE/aws" "$FAKE/npx"

echo "multi-step deletes refuse what is not ours (fake aws)"
PATH="$FAKE:$PATH"
: >"$FAKE_LOG"
expect "bucket with no tags → refused" "1" "$(delete_bucket shop-bucket >/dev/null 2>&1; echo $?)"
expect "bucket tagged for another project → refused" "1" "$(delete_bucket lying-bucket >/dev/null 2>&1; echo $?)"
expect "role with the prefix but without the tag → refused" "1" "$(delete_role idp-not-tagged >/dev/null 2>&1; echo $?)"
expect "role without the prefix → refused" "1" "$(delete_role shop-role >/dev/null 2>&1; echo $?)"
expect "policy without the prefix → refused" "1" "$(delete_policy arn:aws:iam::111122223333:policy/shop >/dev/null 2>&1; echo $?)"
expect "policy with the prefix but without the tag → refused" "1" "$(delete_policy arn:aws:iam::111122223333:policy/idp-untagged >/dev/null 2>&1; echo $?)"
expect "unknown plan verb → refused" "1" "$(run_line 'rm -rf /' >/dev/null 2>&1; echo $?)"
expect "none of those refusals changed anything" "" "$(cat "$FAKE_LOG")"

echo "whole teardown (fake aws + fake cdk)"
teardown() { # prints "<exit code>|<last line>"; the call record is in $FAKE_LOG
  local out rc
  : >"$FAKE_LOG"
  out=$(env "$@" AWS_REGION=eu-west-1 CDK_DIR="$FAKE" WORKLOAD_STACKS="VpcStack KmsStack ClusterStack DnsStack" \
    ZONE_NAME=idp.seniormankelz.dev CLUSTER_NAME=idp SWEEP_WAIT=0 bash "$HERE/../aws-down.sh" --yes 2>&1); rc=$?
  printf '%s|%s' "$rc" "$(tail -1 <<<"$out" | sed $'s/\033\\[[0-9;]*m//g')"
}
EXPECTED_SWEEP='aws elbv2 delete-load-balancer --region eu-west-1 --load-balancer-arn arn:lb/ours
aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch {"Changes":[{"Action":"DELETE","Resourc
aws s3api delete-objects --bucket ours-bucket --delete {"Objects":[{"Key":"a.txt","VersionId":"v1"},{"Key":"b.txt"
aws s3api delete-bucket --bucket ours-bucket
aws iam detach-role-policy --role-name idp-x --policy-arn arn:aws:iam::111122223333:policy/idp-x
aws iam delete-role --role-name idp-x
aws iam delete-policy --policy-arn arn:aws:iam::111122223333:policy/idp-x
aws logs delete-log-group --region eu-west-1 --log-group-name /aws/eks/idp/cluster
aws ec2 delete-network-interface --region eu-west-1 --network-interface-id eni-lb'

expect "normal run → verified, exit 0" "0|Teardown complete and verified." "$(teardown X=0)"
expect "order: cluster first, sweep (interface freed in round 2), the rest, nothing of the other project" \
  "npx cdk destroy ClusterStack"$'\n'"$EXPECTED_SWEEP"$'\n'"npx cdk destroy VpcStack KmsStack ClusterStack DnsStack" "$(cat "$FAKE_LOG")"
expect "no call ever names another project's resource" "0" "$(grep -c -E 'shop|ZSHOP' "$FAKE_LOG")"

expect "first destroy fails → sweep again, retry, verified" "0|Teardown complete and verified." "$(teardown FAKE_FIRST_DESTROY_FAILS=1)"
expect "…and the record shows the failed attempt followed by the retry" \
  "npx cdk destroy VpcStack KmsStack ClusterStack DnsStack (FAILED)"$'\n'"npx cdk destroy VpcStack KmsStack ClusterStack DnsStack" \
  "$(grep 'destroy VpcStack' "$FAKE_LOG")"

echo "plan mode changes nothing"
: >"$FAKE_LOG"
out=$(AWS_REGION=eu-west-1 CDK_DIR="$FAKE" WORKLOAD_STACKS="VpcStack" ZONE_NAME=idp.seniormankelz.dev CLUSTER_NAME=idp \
  bash "$HERE/../aws-down.sh" --plan 2>&1); rc=$?
expect "--plan exits 0 and lists 6 items" "0 6" "$rc $(grep -c -E '^  (aws|delete_)' <<<"$out")"
expect "--plan made no changing call" "" "$(cat "$FAKE_LOG")"
expect "no confirmation, no --yes → aborts and changes nothing" "1 " \
  "$(echo n | AWS_REGION=eu-west-1 CDK_DIR="$FAKE" WORKLOAD_STACKS="VpcStack" ZONE_NAME=idp.seniormankelz.dev CLUSTER_NAME=idp bash "$HERE/../aws-down.sh" >/dev/null 2>&1; echo "$? $(cat "$FAKE_LOG")")"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))

#!/usr/bin/env ruby
# eks-apps-rules.rb — rules the EKS-only ArgoCD apps must meet.
# Run by `make eks-apps-test`. No cluster, no AWS, no network.
#
# WHY: a mistake in these files shows up only in a live EKS session,
# where the clock is billing. Each rule below is a failure that would
# otherwise cost session time: a pod that stays Pending, a controller
# that exits at startup, a role nobody can assume.
#
# Ruby because macOS ships it with YAML built in, and the repo has no
# yq or PyYAML (same reason as composition-iam-rules.rb).
require 'yaml'

# The files contain non-ASCII characters; do not depend on the caller's locale.
Encoding.default_external = Encoding::UTF_8

root = ARGV[0] || '.'
bad = []
read = ->(p) { File.read(File.join(root, p)) }

# --- facts from the CDK code (the other half of each contract) ---------
cluster_ts = read.call('infra/lib/cluster-stack.ts')
role_ts = read.call('infra/lib/load-balancer-controller-role.ts')
block = cluster_ts[/export const FARGATE_NAMESPACES = \{(.*?)\} as const;/m, 1] or abort 'FARGATE_NAMESPACES not found'
fargate = block.gsub(%r{/\*\*.*?\*/}m, '').scan(/'([a-z0-9-]+)'/).flatten
cluster_name = cluster_ts[/props\.clusterName \?\? '([^']+)'/, 1] or abort 'cluster name not found'
sa_ns = role_ts[/LB_CONTROLLER_NAMESPACE = '([^']+)'/, 1] or abort 'LB_CONTROLLER_NAMESPACE not found'
sa_name = role_ts[/LB_CONTROLLER_SERVICE_ACCOUNT = '([^']+)'/, 1] or abort 'LB_CONTROLLER_SERVICE_ACCOUNT not found'

# --- the kind root app must never read the EKS folder ------------------
kind_root = YAML.safe_load(read.call('platform/argocd/root-app.yaml'))
src = kind_root.dig('spec', 'source') || {}
bad << "kind root app reads #{src['path']}, expected platform/argocd/apps" unless src['path'] == 'platform/argocd/apps'
bad << 'kind root app recurses; it would pick up EKS-only apps' if src.dig('directory', 'recurse')

# --- every EKS app -----------------------------------------------------
files = Dir[File.join(root, 'platform/argocd/apps-eks/*.yaml')].sort
abort 'no EKS apps found' if files.empty?
apps = {}
files.each do |f|
  name = File.basename(f)
  text = File.read(f)
  bad << "#{name}: contains a 12-digit number that looks like an AWS account id" if text =~ /\b\d{12}\b/
  YAML.load_stream(text) do |a|
    next unless a.is_a?(Hash) && a['kind'] == 'Application'

    apps[a.dig('metadata', 'name')] = a
    ns = a.dig('spec', 'destination', 'namespace')
    bad << "#{name}: namespace #{ns.inspect} has no Fargate profile; its pods would stay Pending" unless fargate.include?(ns)
    # An app has either one `source` or a list of `sources`.
    ([a.dig('spec', 'source')] + (a.dig('spec', 'sources') || [])).compact.each do |s|
      if s['chart']
        rev = s['targetRevision'].to_s
        bad << "#{name}: chart version #{rev.inspect} is not an exact version" unless rev =~ /\Av?\d+\.\d+\.\d+\z/
      end
      tag = s.dig('helm', 'valuesObject', 'image', 'tag')
      bad << "#{name}: image tag #{tag.inspect} has no sha256 digest" if tag && tag !~ /@sha256:[0-9a-f]{64}\z/
      bad << "#{name}: image tag is latest" if tag.to_s.start_with?('latest')
    end
  end
end

# --- the load balancer controller --------------------------------------
if (lbc = apps['aws-load-balancer-controller'])
  v = lbc.dig('spec', 'source', 'helm', 'valuesObject') || {}
  ns = lbc.dig('spec', 'destination', 'namespace')
  gates = v.dig('controllerConfig', 'featureGates') || {}
  {
    "clusterName must be #{cluster_name} (the IAM role only trusts resources tagged with it)" => v['clusterName'] == cluster_name,
    'region must be set: Fargate has no metadata service to read it from' => v['region'].to_s =~ /\A[a-z]{2}-[a-z]+-\d\z/,
    'vpcTags or vpcId must be set: Fargate has no metadata service' => !(v['vpcTags'] || {}).empty? || !v['vpcId'].to_s.empty?,
    'vpcId must not be in Git (it changes every session); use vpcTags' => v['vpcId'].to_s.empty?,
    'serviceAccount.create must be false (the bootstrap creates it, ADR-0037)' => v.dig('serviceAccount', 'create') == false,
    "serviceAccount.name must be #{sa_name} (the IAM role trusts only that name)" => v.dig('serviceAccount', 'name') == sa_name,
    "namespace must be #{sa_ns} (the IAM role trusts only that namespace)" => ns == sa_ns,
    'defaultTargetType must be ip: Fargate has no instances' => v['defaultTargetType'] == 'ip',
    'enableCertManager must be true (else the webhook cert changes on every sync)' => v['enableCertManager'] == true,
    'enableServiceMutatorWebhook must be false' => v['enableServiceMutatorWebhook'] == false,
    'Shield/WAF must be off: the IAM role has no permissions for them' =>
      %w[enableShield enableWaf enableWafv2].all? { |k| v[k] == false },
    'Gateway API feature gates must be off: Envoy Gateway owns Gateways' =>
      %w[NLBGatewayAPI ALBGatewayAPI GatewayListenerSet].all? { |k| gates[k] == false },
    'LBCapacityReservation must be off: reserved capacity is billed' => gates['LBCapacityReservation'] == false,
    'defaultTags must include Project=idp (budgets and the teardown audit look for it)' =>
      v.dig('defaultTags', 'Project') == 'idp',
  }.each { |msg, ok| bad << "aws-load-balancer-controller: #{msg}" unless ok }
else
  bad << 'aws-load-balancer-controller: Application not found'
end

# --- the bootstrap ServiceAccount --------------------------------------
sa_text = read.call('platform/eks/bootstrap/aws-load-balancer-controller-sa.yaml')
sa = YAML.safe_load(sa_text)
arn = sa.dig('metadata', 'annotations', 'eks.amazonaws.com/role-arn')
bad << "bootstrap SA: name must be #{sa_name}" unless sa.dig('metadata', 'name') == sa_name
bad << "bootstrap SA: namespace must be #{sa_ns}" unless sa.dig('metadata', 'namespace') == sa_ns
bad << 'bootstrap SA: role-arn must be the placeholder, not a real ARN' unless arn == '__LB_CONTROLLER_ROLE_ARN__'
bad << 'bootstrap SA: contains something that looks like an AWS account id' if sa_text =~ /\b\d{12}\b/

# --- the gateway on EKS --------------------------------------------------
# Shared folder minus kind-only files, plus the EKS folder.
docs_in = lambda do |dir, skip = []|
  files_in = Dir[File.join(root, dir, '*.yaml')].sort
  files_in.reject! { |f| skip.any? { |g| File.fnmatch(g, File.basename(f)) } }
  files_in.flat_map { |f| YAML.load_stream(File.read(f)).compact }
end
if (gw = apps['gateway'])
  srcs = gw.dig('spec', 'sources') || []
  shared = srcs.find { |x| x['path'] == 'platform/gateway' }
  eks = srcs.find { |x| x['path'] == 'platform/gateway-eks' }
  bad << 'gateway: must have the two sources platform/gateway and platform/gateway-eks' unless shared && eks
  globs = shared.to_h.dig('directory', 'exclude').to_s.delete('{}').split(',')
  kind_only = Dir[File.join(root, 'platform/gateway/*-kind.yaml')].map { |f| File.basename(f) }
  (kind_only + ['namespace.yaml']).each do |f|
    bad << "gateway: kind-only file #{f} is not excluded from the EKS app" unless globs.any? { |g| File.fnmatch(g, f) }
  end

  objs = docs_in.call('platform/gateway', globs) + docs_in.call('platform/gateway-eks')
  ids = objs.map { |o| [o['kind'], o.dig('metadata', 'namespace'), o.dig('metadata', 'name')] }
  ids.group_by { |i| i }.each { |i, n| bad << "gateway: #{i.compact.join('/')} is defined #{n.size} times" if n.size > 1 }
  bad << 'gateway: a host port is requested; Fargate has no host to bind it on' if objs.to_s =~ /hostPort|hostNetwork/

  nsobj = objs.find { |o| o['kind'] == 'Namespace' }
  bad << 'gateway: no Namespace in the EKS set' unless nsobj
  level = nsobj.to_h.dig('metadata', 'labels', 'pod-security.kubernetes.io/enforce')
  bad << "gateway: namespace enforces Pod Security #{level.inspect}, expected restricted" unless level == 'restricted'

  gc = objs.find { |o| o['kind'] == 'GatewayClass' }
  ep = objs.find { |o| o['kind'] == 'EnvoyProxy' }
  if gc && ep
    ref = gc.dig('spec', 'parametersRef') || {}
    same = ref['name'] == ep.dig('metadata', 'name') && ref['namespace'] == ep.dig('metadata', 'namespace')
    bad << 'gateway: GatewayClass.parametersRef does not point at the EKS EnvoyProxy' unless same
    svc = ep.dig('spec', 'provider', 'kubernetes', 'envoyService') || {}
    ann = svc['annotations'] || {}
    {
      'Service type must be LoadBalancer' => svc['type'] == 'LoadBalancer',
      'loadBalancerClass must be service.k8s.aws/nlb (else the built-in code targets nodes; Fargate has none)' =>
        svc['loadBalancerClass'] == 'service.k8s.aws/nlb',
      'scheme must be internet-facing (the default is internal)' =>
        ann['service.beta.kubernetes.io/aws-load-balancer-scheme'] == 'internet-facing',
      'target type must be ip: Fargate has no instances' =>
        ann['service.beta.kubernetes.io/aws-load-balancer-nlb-target-type'] == 'ip',
    }.each { |msg, ok| bad << "gateway: EnvoyProxy #{msg}" unless ok }
  else
    bad << 'gateway: GatewayClass or EnvoyProxy missing from the EKS set'
  end
  %w[Gateway Certificate HTTPRoute].each do |k|
    bad << "gateway: no #{k} in the EKS set (was a shared file excluded by mistake?)" unless objs.any? { |o| o['kind'] == k }
  end
else
  bad << 'gateway: Application not found'
end

if bad.empty?
  puts "eks-apps-test: OK (#{files.size} app(s), #{fargate.size} Fargate namespaces)"
else
  bad.each { |b| puts "FAIL #{b}" }
  exit 1
end

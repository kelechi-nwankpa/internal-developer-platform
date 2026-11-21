#!/usr/bin/env ruby
# composition-iam-rules.rb — rules every rendered IAM resource must meet.
# Used by composition-test.sh (check 3). Takes one rendered YAML file;
# prints one line per problem and exits 1 if there is any.
#
# WHY separate from the expected.yaml comparison: expected files can be
# regenerated without being read. These rules cannot be regenerated; a
# wildcard resource or a role any pod can assume fails here regardless.
#
# Ruby because macOS ships it with YAML and JSON built in, and the repo
# has no yq or PyYAML.
require 'yaml'
require 'json'

bad = []
YAML.load_stream(File.read(ARGV.fetch(0))) do |d|
  next unless d.is_a?(Hash) && d['apiVersion'].to_s.start_with?('iam.aws.upbound.io/')

  fp = d.dig('spec', 'forProvider') || {}
  case d['kind']
  when 'Policy'
    begin
      doc = JSON.parse(fp['policy'])
    rescue StandardError
      bad << 'Policy: not valid JSON'
      next
    end
    doc['Statement'].each do |s|
      Array(s['Action']).each do |a|
        bad << "Policy: action #{a} is not a plain s3 action" unless a =~ /\As3:[A-Za-z]+\z/
      end
      Array(s['Resource']).each do |r|
        bad << "Policy: resource #{r} is not one named bucket" unless r =~ %r{\Aarn:aws:s3:::[a-z0-9.-]+(/\*)?\z}
      end
      bad << 'Policy: statement has no Resource' if Array(s['Resource']).empty?
    end
  when 'Role'
    begin
      doc = JSON.parse(fp['assumeRolePolicy'])
    rescue StandardError
      bad << 'Role: trust policy is not valid JSON'
      next
    end
    bad << 'Role: expected exactly one trust statement' unless doc['Statement'].size == 1
    s = doc['Statement'][0]
    bad << 'Role: action must be sts:AssumeRoleWithWebIdentity' unless s['Action'] == 'sts:AssumeRoleWithWebIdentity'
    unless s.dig('Principal', 'Federated') =~ %r{\Aarn:aws:iam::\d{12}:oidc-provider/[^*]+\z}
      bad << 'Role: principal must be one OIDC provider'
    end
    cond = s['Condition'] || {}
    bad << 'Role: only StringEquals conditions are allowed' unless cond.keys == ['StringEquals']
    eq = cond['StringEquals'] || {}
    sub = eq.find { |k, _| k.end_with?(':sub') }
    aud = eq.find { |k, _| k.end_with?(':aud') }
    unless sub && sub[1] =~ /\Asystem:serviceaccount:[a-z0-9-]+:[a-z0-9-]+\z/
      bad << 'Role: trust is not pinned to one ServiceAccount'
    end
    bad << 'Role: audience is not pinned to sts.amazonaws.com' unless aud && aud[1] == 'sts.amazonaws.com'
  end
end
puts bad
exit(bad.empty? ? 0 : 1)

# AWS Domain Visibility Notes

I was able to see the available domains by using the local AWS CLI credentials, specifically the `acm-audit` profile.

First, I checked the configured AWS profiles:

```bash
aws configure list-profiles
```

That showed:

```text
acm-audit
```

Then I queried Route 53 Domains with that profile:

```bash
AWS_PROFILE=acm-audit aws route53domains list-domains
```

That returned:

```text
skeles.com
yoyowza.com
```

Another Codex session may not be able to see the domains if one of these is different there:

- It does not have the same working directory or shell environment.
- It does not have access to the same local AWS config files.
- It is not using `AWS_PROFILE=acm-audit`.
- It is using plain `aws ...`, which fails here because no default AWS profile is set.
- Its AWS credentials or profile have not been loaded into that session.

To check from another Codex session, run:

```bash
AWS_PROFILE=acm-audit aws route53domains list-domains
```

If that fails, inspect the configured profiles and identity:

```bash
aws configure list-profiles
aws sts get-caller-identity --profile acm-audit
```

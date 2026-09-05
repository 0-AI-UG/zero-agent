# OCD deployment configuration

Each `.ocd-deploy.json` has an explicit `env` map. A string is a runtime
literal; `{ "from": "environment.KEY" }` reads KEY from the named existing
environment. Only mapped user variables are delivered. Platform and storage
bindings add their own variables.

Set secrets and other stored values with `ocd envs set` before deploying.
Missing references fail deployment. Deploy does not create environments,
merge defaults, prompt for values, or write shared configuration. Generated
credentials are an explicit setup action:

```bash
ocd envs generate <environment> JWT_SECRET --type=password
```

Generation preserves an existing value. Use `ocd envs set` for intentional
rotation. Runtime environment changes need container recreation, not an image
rebuild. These values do not supply frontend compile-time build configuration.

Review configuration with `ocd deploy <manifest> --dry-run`, then deploy the
manifest. Configure optional variables by adding explicit mappings; omitted
optional variables use the application's own behavior.

For `server/.ocd-deploy.json`, create the `zero-server` environment and generate
`JWT_SECRET` before its first deployment. Add environment references for optional
LLM/provider keys or `CREDENTIALS_KEY` when those features are configured.

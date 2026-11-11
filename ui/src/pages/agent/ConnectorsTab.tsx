import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InstallConnector, RISK_TONE, useCatalog, useConnectors } from '../../components/connectors.js';
import { Button, Check, Chip, ConfirmButton, Empty, ErrorNote, Field, Load, Loading, Panel, Segmented, Status } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import type { Agent, Connector, ConnectorGrant, ConnectorTemplate, GrantInput } from '../../lib/api.js';
import { humanize } from '../../lib/format.js';
import { k, useOrg } from '../../lib/org.js';
import { useAction, useQuery } from '../../lib/query.js';
import { toast } from '../../lib/toast.js';

type Policy = 'allowed' | 'ask' | 'off';
const POLICIES: ReadonlyArray<{ value: Policy; label: string }> = [{ value: 'allowed', label: 'Allowed' }, { value: 'ask', label: 'Ask first' }, { value: 'off', label: 'Off' }];

function GrantEditor({ agent, connector, grant }: { agent: Agent; connector: Connector; grant: ConnectorGrant }) {
  const { org } = useOrg();
  const tools = useQuery(k(org.id, 'connector', connector.id, 'tools'), () => api.connectorTools(org.id, connector.id));
  const [defaultPolicy, setDefaultPolicy] = useState<Policy>(grant.defaultPolicy);
  const [policies, setPolicies] = useState<Record<string, Policy>>(grant.toolPolicies);
  const [allow, setAllow] = useState<string[] | null>(grant.toolAllowlist ?? null);
  const [authRef, setAuthRef] = useState(grant.authRef ?? '');
  useEffect(() => {
    setDefaultPolicy(grant.defaultPolicy);
    setPolicies(grant.toolPolicies);
    setAllow(grant.toolAllowlist ?? null);
    setAuthRef(grant.authRef ?? '');
  }, [grant]);
  const save = useAction(() => {
    const input: GrantInput = { defaultPolicy, toolPolicies: policies, toolAllowlist: allow, authRef: authRef.trim() || null };
    return api.grantConnector(org.id, connector.id, agent.id, input);
  }, { invalidate: [k(org.id, 'grants')], success: 'Grant saved' });
  const dirty = defaultPolicy !== grant.defaultPolicy || JSON.stringify(policies) !== JSON.stringify(grant.toolPolicies)
    || JSON.stringify(allow) !== JSON.stringify(grant.toolAllowlist ?? null) || authRef.trim() !== (grant.authRef ?? '');
  const names = tools.data?.map((t) => t.name) ?? [];
  const setTool = (tool: string, p: Policy | 'default') => {
    const next = { ...policies };
    if (p === 'default') delete next[tool];
    else next[tool] = p;
    setPolicies(next);
  };
  return (
    <form className="form grant" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="form-grid">
        <Field label="Default for every tool"><Segmented label="Default policy" value={defaultPolicy} onChange={setDefaultPolicy} options={POLICIES} /></Field>
        <Field label="Account for this agent (optional)" hint="A stored secret name, so two agents can use the same connector with different accounts.">
          <input value={authRef} onChange={(e) => setAuthRef(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="Uses the connector's own credentials" />
        </Field>
      </div>
      <Check label="Restrict this agent to a list of tools" checked={allow !== null} onChange={(on) => setAllow(on ? names : null)} hint="Tools outside the list are invisible to the agent." />
      {tools.data ? (
        tools.data.length === 0 ? <p className="muted">This connector exposes no tools.</p> : (
          <ul className="tool-list">
            {tools.data.map((t) => {
              const listed = allow === null || allow.includes(t.name);
              const effective = policies[t.name] ?? 'default';
              return (
                <li key={t.name} className={!listed ? 'tool-off' : t.quarantined ? 'tool-quarantined' : ''}>
                  {allow !== null ? <input type="checkbox" aria-label={`Include ${t.name}`} checked={listed} onChange={(e) => setAllow(e.target.checked ? [...allow, t.name] : allow.filter((x) => x !== t.name))} /> : null}
                  <div className="grow">
                    <code>{t.name}</code> {RISK_TONE[t.risk] ? <Chip tone={RISK_TONE[t.risk]}>{humanize(t.risk)}</Chip> : null}
                    {t.quarantined ? <Chip tone="stop">Changed upstream, disabled until re-trusted</Chip> : null}
                    <span className="field-hint">{t.description}</span>
                  </div>
                  <Segmented small label={`Policy for ${t.name}`} value={effective} onChange={(p) => setTool(t.name, p)}
                    options={[{ value: 'default', label: 'Default' }, ...POLICIES]} />
                </li>
              );
            })}
          </ul>
        )
      ) : tools.error ? <ErrorNote error={tools.error} retry={tools.reload} /> : <Loading lines={2} label="Discovering tools" />}
      <ErrorNote error={save.error} />
      <div className="form-actions"><Button type="submit" variant="primary" busy={save.busy} disabled={!dirty}>Save grant</Button></div>
    </form>
  );
}

function ConnectorGrantRow({ agent, connector, grant, shared }: { agent: Agent; connector: Connector; grant?: ConnectorGrant; shared: boolean }) {
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const inv = { invalidate: [k(org.id, 'grants'), `${org.id}/agent`] };
  const give = useAction(async () => {
    const res = await api.grantConnector(org.id, connector.id, agent.id, {});
    toast(res.approval ? 'Grant sent for approval' : `Granted ${connector.name}`, 'ok');
    setOpen(true);
  }, inv);
  const revoke = useAction(() => api.revokeGrant(org.id, connector.id, agent.id), { ...inv, success: `Revoked ${connector.name}` });
  return (
    <li className="connector">
      <div className="connector-head">
        <div className="grow">
          <div className="row">
            <strong>{connector.name}</strong><Chip>{humanize(connector.kind)}</Chip>
            {connector.status !== 'active' ? <Status value={connector.status} /> : null}
            {grant ? <Chip tone="go">Granted, default {grant.defaultPolicy === 'ask' ? 'ask first' : grant.defaultPolicy}</Chip> : shared ? <Chip tone="info">Shared, no per-tool rules</Chip> : <Chip>Not granted</Chip>}
          </div>
        </div>
        <div className="row row-tight">
          {grant ? (
            <>
              <Button small onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide tool policies' : 'Tool policies'}</Button>
              <ConfirmButton small variant="quiet" danger label="Revoke" title={`Revoke ${connector.name}`} confirmLabel="Revoke grant" message={`${agent.name} loses its per-tool rules and account binding for this connector.`} onConfirm={() => revoke.run()} />
            </>
          ) : <Button small variant="primary" busy={give.busy} onClick={() => void give.run()}>Grant to {agent.name}</Button>}
        </div>
      </div>
      {grant && open ? <GrantEditor agent={agent} connector={connector} grant={grant} /> : null}
    </li>
  );
}

export function ConnectorsTab({ agent }: { agent: Agent }) {
  const { org, base } = useOrg();
  const connectors = useConnectors(org.id);
  const catalog = useCatalog();
  const grants = useQuery(k(org.id, 'grants', agent.id), () => api.listGrants(org.id, { agentId: agent.id }), { events: ['approval.decided', 'agent.updated'], orgId: org.id });
  const caps = useQuery(k(org.id, 'agent', agent.id, 'capabilities'), () => api.agentCapabilities(org.id, agent.id), { events: ['agent.', 'org.updated'], orgId: org.id });
  const [install, setInstall] = useState<{ template: ConnectorTemplate | null } | null>(null);
  const inherited = new Set(caps.data?.connectorIds ?? []);
  return (
    <div className="stack-lg">
      <Panel title="Connectors" flush actions={<Link to={`${base}/connectors`}>Manage all connectors</Link>}>
        <Load q={connectors} empty={<Empty title="No connectors installed"><p>Install one from the catalog below, then grant it here.</p></Empty>}>
          {(list) => (
            <ul className="connectors">
              {list.map((c) => <ConnectorGrantRow key={c.id} agent={agent} connector={c} grant={grants.data?.find((g) => g.connectorId === c.id)} shared={inherited.has(c.id)} />)}
            </ul>
          )}
        </Load>
      </Panel>
      <Panel title="Install from the catalog">
        <Load q={catalog} empty={<Empty title="The catalog is empty" />}>
          {(list) => (
            <ul className="catalog">
              {list.map((t) => (
                <li key={t.id}>
                  <div className="grow"><strong>{t.name}</strong> <Chip>{humanize(t.category)}</Chip><span className="field-hint">{t.description}</span></div>
                  <Button small onClick={() => setInstall({ template: t })}>Install</Button>
                </li>
              ))}
            </ul>
          )}
        </Load>
      </Panel>
      <InstallConnector open={install !== null} onClose={() => setInstall(null)} template={install?.template} />
    </div>
  );
}

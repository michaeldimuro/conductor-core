import type { Command } from 'commander';
import { REVISION_KINDS } from '../../api/types.js';
import type { CliDeps } from '../deps.js';
import { action, arg, oneOf } from '../command.js';
import { ago, clip } from '../output.js';

/**
 * `conductor revisions` — history and rollback of every revisioned kind of
 * configuration (org, dept, agent, goal, playbook, project, connector,
 * connector_grant, browser_profile, gateway, webhook).
 */
export function revisionCommands(program: Command, deps: CliDeps): void {
  const revisions = program.command('revisions').alias('revision').description('config history: list the revisions of anything you configured and roll back');

  revisions
    .command('list <kind> <id>')
    .description(`revisions of one entity, newest first (kind: ${REVISION_KINDS.join(' | ')})`)
    .action(action(deps, async (ctx, args) => {
      const kind = oneOf(arg(args, 0, 'kind'), '<kind>', REVISION_KINDS);
      const id = arg(args, 1, 'id');
      // Gateways are installation-wide; every other kind lives inside an org.
      const list = kind === 'gateway'
        ? await ctx.client().listGatewayRevisions(id)
        : await ctx.client().listRevisions(await ctx.org(), { entityKind: kind, entityId: id });
      ctx.emit(list, () => {
        ctx.table(
          ['revision', 'when', 'author', 'note', 'id'],
          list.map((r) => [`r${r.revision}`, ago(r.ts, ctx.deps.now()), r.author, clip(r.note ?? '', 60), r.id]),
          `no revisions recorded for ${kind} ${id}`,
        );
        if (list.length > 1) ctx.note(ctx.style.dim('restore one: conductor revisions rollback <id>'));
      });
    }));

  revisions
    .command('show <revisionId>')
    .description('print one revision with its stored snapshot (secrets are never part of a snapshot)')
    .action(action(deps, async (ctx, args) => {
      const r = await ctx.client().getRevision(arg(args, 0, 'revisionId'));
      ctx.emit(r, () => {
        ctx.fields([['id', r.id], ['entity', `${r.entityKind} ${r.entityId}`], ['revision', `r${r.revision}`], ['author', r.author], ['note', r.note], ['when', ago(r.ts, ctx.deps.now())]]);
        ctx.lines(['', JSON.stringify(r.snapshot, null, 2)]);
      });
    }));

  revisions
    .command('rollback <revisionId>')
    .description('restore the configuration stored in a revision (recorded as a new revision)')
    .action(action(deps, async (ctx, args) => {
      const r = await ctx.client().rollbackToRevision(arg(args, 0, 'revisionId'));
      ctx.emit(r, () => ctx.ok(`${r.entityKind} ${r.entityId} rolled back to r${r.rolledBackTo} (now r${r.revision})`));
    }));
}

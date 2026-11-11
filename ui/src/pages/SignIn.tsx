import { useState } from 'react';
import { Button, ErrorNote, Field, Lamp, Toasts } from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAction } from '../lib/query.js';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const signIn = useAction(async () => {
    await api.createSession(token.trim());
    onSignedIn();
  }, { quiet: true });
  return (
    <div className="center-screen">
      <main className="center-card">
        <p className="wordmark"><Lamp tone="warn" />Conductor</p>
        <div className="stack">
          <h1>Sign in to this console</h1>
          <p className="dim">On the Mac that runs Conductor, open a terminal and run <code>conductor open</code>. It opens this console already signed in.</p>
          <p className="dim">For a phone or another device, run <code>conductor pair</code> on the Mac and open the link it prints. Or paste a token below: it is exchanged for a session cookie and is never stored in this browser.</p>
        </div>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void signIn.run();
          }}
        >
          <Field label="Token" hint="The owner token is the file owner.token in the Conductor home directory on the Mac.">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
          </Field>
          <ErrorNote error={signIn.error} />
          <Button type="submit" variant="primary" busy={signIn.busy} disabled={!token.trim()}>Sign in</Button>
        </form>
      </main>
      <Toasts />
    </div>
  );
}

import { useAuth } from '../../contexts/AuthContext';
import CodeMgmt from './CodeMgmt';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  'product-owner': 'Product Owner',
  fachpartner: 'Fachpartner',
};

export default function ToolHubWelcome({ workspace }: { workspace?: string } = {}) {
  const { user, authEnabled } = useAuth();
  const role = user?.role ?? 'admin';
  const name = user?.name ?? 'Partner';

  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: '24px 32px',
      color: 'var(--tn-text, #c0caf5)',
      fontSize: 13, lineHeight: 1.55,
    }}>
      <div style={{ maxWidth: 760 }}>
        <h1 style={{
          margin: 0, marginBottom: 8,
          fontSize: 22, fontWeight: 600,
          color: 'var(--tn-blue, #7aa2f7)',
        }}>
          Willkommen, {name.split(' ')[0]}.
        </h1>
        <div style={{ fontSize: 12, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 24 }}>
          Du bist als <b>{ROLE_LABEL[role] ?? role}</b> auf der WerkING Partner-Plattform angemeldet.
        </div>

        {workspace && authEnabled && user && <CodeMgmt workspace={workspace} />}

        <Section title="Was ist das hier?">
          Die <b>WerkING Partner-Plattform</b> ist die gemeinsame Entwicklungsumgebung für
          alle, die an WerkING&nbsp;Tools mitbauen. Du arbeitest direkt im Browser — keine
          Installation, kein Terminal. Jeder Workspace links oben (Engelmann AI Hub,
          WerkING Energy, WerkING Report, …) ist ein eigenständiges Produkt mit eigenem
          Chat, eigenem Browser-Preview und eigener Tool-Auswahl.
        </Section>

        <Section title="Was siehst du auf dem Bildschirm?">
          <ul style={{ paddingLeft: 20, margin: '4px 0' }}>
            <li><b>Links oben — Chat:</b> Hier sprichst du mit Claude. Aufgabe rein,
              Claude liest deinen Code, baut, testet, committed.</li>
            <li><b>Links unten — Browser:</b> Live-Preview der App, an der du gerade
              arbeitest. Aktualisiert sich nach jedem Build automatisch.</li>
            <li><b>Rechts — Tool Hub:</b> Diese Ansicht. Alle Werkzeuge auf einen Klick:
              Files, Notes, Tasks, Inbox, Feedback, Mail, Kalender, …</li>
          </ul>
        </Section>

        <Section title={`Deine Rolle: ${ROLE_LABEL[role] ?? role}`}>
          {role === 'product-owner' && (
            <>
              Als <b>Product Owner</b> entwickelst du dein Produkt eigenständig weiter.
              Du kannst Änderungen committen und auf <code>develop</code> pushen — Vercel
              baut automatisch eine Preview. Pro&shy;duktions-Releases laufen über
              Rafael (<code>deploy-production</code>).
            </>
          )}
          {role === 'fachpartner' && (
            <>
              Als <b>Fachpartner</b> sicherst du die fachliche Qualität deines Produkts.
              Du testest Workflows mit echten Daten, gibst Feedback im Chat und nutzt
              den <i>Feedback</i>-Tab oben, um Punkte für die Entwicklung zu sammeln.
              Code-Änderungen pushed Rafael.
            </>
          )}
          {role === 'admin' && (
            <>
              Als <b>Admin</b> hast du Zugriff auf alle Workspaces und alle Tools —
              inklusive Mission Control, Bridge-Monitor, Repo-Dashboard und
              Partner-Server-Health. Über den Tool Hub erreichst du jeden Bereich
              direkt.
            </>
          )}
        </Section>

        <Section title="So legst du los">
          <ol style={{ paddingLeft: 20, margin: '4px 0' }}>
            <li>Workspace links oben wählen (z.&nbsp;B. <i>WerkING Energy</i>).</li>
            <li>Im <b>Chat</b> deine Aufgabe formulieren — auf Deutsch, ganz normal.
              Claude fragt nach, wenn etwas unklar ist.</li>
            <li>Im <b>Browser</b> daneben die Live-App im Auge behalten.</li>
            <li>Über die Icons oben hier im <b>Tool Hub</b> Files öffnen, Notizen
              machen, Tasks anlegen.</li>
          </ol>
        </Section>

        <Section title="Hilfe & Support">
          Fragen, Bugs, Wünsche → <i>Feedback</i>-Tool oben oder direkt an Rafael per
          Chat. Antworten kommen meist innerhalb eines Tages.
        </Section>

        <div style={{
          marginTop: 32, paddingTop: 12,
          borderTop: '1px solid var(--tn-border, #292e42)',
          fontSize: 11, color: 'var(--tn-text-muted, #565f89)',
        }}>
          Klick ein Tool oben an, um es zu öffnen. Diese Startseite siehst du immer,
          wenn der Tool Hub frisch geöffnet wird.
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{
        margin: '0 0 6px', fontSize: 14, fontWeight: 600,
        color: 'var(--tn-text, #c0caf5)',
      }}>
        {title}
      </h2>
      <div style={{ color: 'var(--tn-text-muted, #a9b1d6)' }}>{children}</div>
    </section>
  );
}

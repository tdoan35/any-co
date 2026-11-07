import { Link } from "react-router";
import { Download, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Face, agentOf } from "@/components/weave/parts";
import type { Report } from "@/lib/types";
import { streamUrl } from "@/lib/api";

export function ReportView({ report, loopHref }: { report: Report; loopHref?: string }) {
  return (
    <div className="grid grid-cols-[1fr_260px] gap-10 px-8 py-8">
      <article className="max-w-[680px] space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{report.title}</h1>
          {report.kind === "illustrative" && <span className="mt-1 inline-block rounded-full bg-replay-soft px-2 py-0.5 text-xs font-medium text-replay">Illustrative</span>}
          <p className="mt-1 text-sm text-muted-foreground">{report.intro}</p>
        </div>
        {report.setup && report.setup.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold">Setup</h2>
            <dl className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-2">
              {report.setup.map((row) => <div key={row.label}><dt className="text-xs text-muted-foreground">{row.label}</dt><dd>{row.value}</dd></div>)}
            </dl>
          </section>
        )}
        <section>
          <h2 className="mb-2 text-sm font-semibold">Summary</h2>
          <p className="text-sm leading-relaxed">{report.summary}</p>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Held-out perplexity</h2>
          <div className="rounded-xl border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Configuration</TableHead><TableHead>Perplexity</TableHead><TableHead>Δ vs baseline</TableHead><TableHead>Valid</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {report.results.map((r) => (
                  <TableRow key={r.config}>
                    <TableCell className="font-medium">{r.config}</TableCell>
                    <TableCell className="font-mono">{r.ppl}</TableCell>
                    <TableCell className="font-mono">{r.delta}</TableCell>
                    <TableCell>{r.valid
                      ? <Badge className="bg-ok-soft text-ok hover:bg-ok-soft">valid</Badge>
                      : <Badge className="bg-warn-soft text-warn hover:bg-warn-soft">contaminated</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Caveats</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">{report.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </section>
      </article>
      <aside className="space-y-6 text-sm">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Provenance</h2>
          <dl className="space-y-1.5">
            {report.provenance.map((p) => (
              <div key={p.label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{p.label}</dt><dd className="text-right">{p.value}</dd></div>
            ))}
          </dl>
          {loopHref && <Link to={loopHref} className="mt-2 inline-block text-xs underline underline-offset-2">Replay the loop</Link>}
        </section>
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Made by</h2>
          <div className="flex gap-1.5">
            {report.madeBy.map((id) => (
              <span key={id} title={`${agentOf(id).name} · ${agentOf(id).role}`}><Face id={id} size="size-7" /></span>
            ))}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Artifacts</h2>
          <ul className="space-y-2">
            {report.artifacts.map((a) => (
              <li key={a.name} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <Download className="size-3.5 text-muted-foreground" />
                <div>{a.id ? <a href={streamUrl(`/artifacts/${encodeURIComponent(a.id)}`)} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-2">{a.name}</a> : <div className="font-mono text-xs">{a.name}</div>}<div className="text-[11px] text-muted-foreground">{a.from}</div></div>
              </li>
            ))}
          </ul>
        </section>
        {report.emailed && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="size-3.5" />Also emailed to you via AgentMail</p>}
      </aside>
    </div>
  );
}

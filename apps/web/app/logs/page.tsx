'use client';
import { PageHeader, Panel } from '../components';
import { LiveLogViewer } from '../realtime-view';

export default function LogsPage() {
  return <>
    <PageHeader eyebrow="Megfigyelhetőség" title="Naplók" subtitle="A bot és a szerver eseményei valós időben" />
    <Panel title="Auditfolyam" description="Élő eseménynapló: döntések, vételek, zárások, hibák.">
      <LiveLogViewer />
    </Panel>
  </>;
}

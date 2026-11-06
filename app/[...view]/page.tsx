import { Workspace } from '@/components/meeti';
export default async function Page({ params }: { params: Promise<{ view: string[] }> }) { const { view } = await params; return <Workspace view={view[0]} />; }

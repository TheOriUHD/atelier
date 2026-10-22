import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileImage, FileSpreadsheet, FileText, FileCode2, Presentation } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { FileCard, OutputFiles, fileIcon } from './file-cards.tsx';

const workspace: WorkspaceSummary = { id: 'w', kind: 'local', name: 'reports', root: '/home/ada/reports', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 0 };
const report = { path: 'out/report.md', name: 'report.md' };
const memo = { path: 'memo.docx', name: 'memo.docx' };

describe('file cards', () => {
  it('show the name, where it is in the folder and what opening does', () => {
    const onOpen = vi.fn();
    render(<OutputFiles files={[report, memo]} workspace={workspace} onOpen={onOpen} />);
    const cards = within(screen.getByRole('region', { name: 'Files from this task' })).getAllByRole('button');
    expect(cards.map((c) => c.textContent)).toEqual(['report.mdin reports/outOpen', 'memo.docxin reportsDownload']);
    fireEvent.click(cards[0]!);
    expect(onOpen).toHaveBeenCalledWith(report);
  });

  it('come as compact rows for the progress column', () => {
    const onOpen = vi.fn();
    render(<FileCard file={report} workspace={workspace} compact onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: /report\.md/ });
    expect(row.getAttribute('title')).toBe('out/report.md · Open');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(report);
  });

  it('pick an icon by type', () => {
    expect(['a.md', 'b.xlsx', 'c.pptx', 'd.png', 'e.ts'].map(fileIcon)).toEqual([FileText, FileSpreadsheet, Presentation, FileImage, FileCode2]);
  });
});

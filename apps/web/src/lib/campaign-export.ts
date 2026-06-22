import { api } from '@/lib/api';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function downloadCampaignDetails(campaignId: string, campaignName: string) {
  const response = await api.get(`/api/campaigns/${campaignId}/recipients/export`, {
    responseType: 'blob',
  });
  const blob = new Blob([response.data], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  try {
    const filename =
      parseFilenameFromContentDisposition(
        response.headers['content-disposition'] as string | undefined,
      ) ?? `${campaignName || 'campaign'}-活动明细.xlsx`;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseFilenameFromContentDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall through to the ASCII filename.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

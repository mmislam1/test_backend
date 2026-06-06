const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const firstNonEmpty = (...values: unknown[]): string => {
  for (const value of values) {
    const normalized = asText(value);
    if (normalized) return normalized;
  }
  return '';
};

const hostFromUrl = (url: string): string => {
  if (!url) return '';

  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const pickMatchFromList = (details: any) => {
  if (Array.isArray(details?.matches) && details.matches.length > 0) {
    return details.matches[0];
  }

  if (Array.isArray(details?.visual_matches) && details.visual_matches.length > 0) {
    return details.visual_matches[0];
  }

  if (Array.isArray(details?.exact_matches) && details.exact_matches.length > 0) {
    return details.exact_matches[0];
  }

  return null;
};

export const normalizeStoredResultDetails = (details: any) => {
  const top = details ?? {};
  const firstMatch = pickMatchFromList(top) ?? {};

  const link = firstNonEmpty(
    top.link,
    top.url,
    top.targetUrl,
    top.pageUrl,
    top.page?.url,
    firstMatch.link,
    firstMatch.url,
    firstMatch.targetUrl,
    firstMatch.pageUrl,
  );

  const source = firstNonEmpty(
    top.source,
    top.site,
    top.domain,
    top.displayed_link,
    top.page?.domain,
    firstMatch.source,
    firstMatch.site,
    firstMatch.domain,
    firstMatch.displayed_link,
    hostFromUrl(link),
  );

  const title = firstNonEmpty(
    top.title,
    top.name,
    top.snippet,
    top.page?.title,
    firstMatch.title,
    firstMatch.name,
    firstMatch.snippet,
  );

  return {
    ...top,
    title,
    link,
    source,
  };
};

export const normalizeSerpMatchForResult = (match: any, fallbackImageUrl: string) => {
  const normalizedDetails = normalizeStoredResultDetails(match);
  const image = firstNonEmpty(match?.thumbnail, match?.image, fallbackImageUrl);

  return {
    image,
    details: {
      title: normalizedDetails.title,
      link: normalizedDetails.link,
      source: normalizedDetails.source,
    },
  };
};

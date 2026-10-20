# Provider comparison, October 2026

Run on 2026-10-20 with `npm run eval:search`: 42 queries from `evals/search-queries.json` (26 English, 16 Chinese; web, news, scholar, and code), 8 results requested per call, 461 provider calls in total. Raw results stay out of Git in `evals/results/`.

## How a result list is scored

No LLM judge. Each query lists hosts an expert would expect near the top (`gold`). For each result list:

- `gold@3`: 1 when any of the first three results is on a gold host.
- `gold share`: the fraction of all results on gold hosts.
- `lang`: for Chinese queries, the fraction of titles containing Chinese.
- `dated`: the fraction of results carrying a date. For news, `fresh` counts results dated within 14 days.
- `dup`: results that are the same page in another release or mirror.
- `score`: web, scholar, and code use 0.4 gold@3 + 0.2 gold share + 0.15 lang + 0.05 dated + 0.2 count − 0.1 dup. News uses 0.3 gold@3 + 0.15 gold share + 0.3 fresh + 0.1 lang + 0.15 count. A failed call scores 0.

Three queries per news, scholar, and code bucket is a small sample. Read those rows as direction, not proof.

## What changed because of it

- Exact mode no longer starts with Exa. Exa put a gold source in the top three for half of the English exact queries and for none of the Chinese ones; Parallel, Brave, and Serper did for all of them.
- Official mode starts with Exa. 92% of its English results and 81% of its Chinese results came from official hosts, the highest of any provider.
- Chinese queries lead with Brave (`zh-hans`, `CN`) and Serper (`cn`, `zh-cn`). Parallel's Chinese results had English titles 22% of the time, and Querit's 93% of the time.
- English general stays Parallel first: it scored within 0.01 of Exa at about a third of the latency, with the highest gold share. Serper and Exa follow; You.com and Brave dropped behind them.
- Brave with and without Chinese settings tied on Chinese general queries; the settings won clearly on exact (0.89 vs 0.80) and official (0.77 vs 0.73), so the route always sends them.
- Current mode starts with You.com with `freshness`, which led both the English and Chinese news buckets.
- New `scholar` mode: Exa with a research-paper objective, then Parallel, You.com, and Serper Scholar.
- New `code` mode: Exa Advanced with `category: github` put a gold source in the top three for every query and kept every result on a gold host.
- Querit left the automatic routes. Tavily stays only as the last fallback: it ranked last or near last in every bucket and returns no dates.
- Jina is disabled in the reference setup: 8 of its 33 calls timed out and its median latency was 13 seconds. TinyFish returned results nearly identical to Serper's, so it adds no independent perspective; it stays manual.

## Tables

`p50 ms` is the median latency of successful calls. Variants ending in `-zh` add Chinese-market parameters; `-news` variants add a one-week window.

### en/web:general
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| exa | 0.84 | 1 | 0.39 | 1 | 0.3 | 2919 | 0/8 |
| parallel | 0.83 | 1 | 0.61 | 1 | 0.12 | 792 | 0/8 |
| serper | 0.82 | 1 | 0.22 | 1 | 0.61 | 2346 | 0/8 |
| jina | 0.82 | 1 | 0.22 | 1 | 0.61 | 13316 | 0/8 |
| tinyfish | 0.82 | 1 | 0.22 | 1 | 0.55 | 1639 | 0/8 |
| querit | 0.80 | 0.88 | 0.27 | 1 | 1 | 1241 | 0/8 |
| anysearch | 0.76 | 0.88 | 0.14 | 1 | 0.59 | 4453 | 0/8 |
| you | 0.73 | 0.75 | 0.2 | 1 | 0.77 | 747 | 0/8 |
| brave | 0.73 | 0.75 | 0.2 | 1 | 0.77 | 688 | 0/8 |
| tavily | 0.48 | 0.25 | 0.14 | 1 | 0 | 2597 | 0/8 |
| linkup | 0.41 | 0.13 | 0.06 | 1 | 0 | 1316 | 0/8 |

### en/web:exact
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| parallel | 0.89 | 1 | 0.66 | 1 | 0.51 | 774 | 0/4 |
| brave | 0.88 | 1 | 0.44 | 1 | 0.75 | 615 | 0/4 |
| you | 0.87 | 1 | 0.41 | 1 | 0.78 | 593 | 0/4 |
| tinyfish | 0.86 | 1 | 0.34 | 1 | 0.88 | 1186 | 0/4 |
| serper | 0.85 | 1 | 0.28 | 1 | 0.94 | 1509 | 0/4 |
| anysearch | 0.85 | 1 | 0.28 | 1 | 0.91 | 2932 | 0/4 |
| tavily | 0.71 | 0.75 | 0.31 | 1 | 0 | 2152 | 0/4 |
| exa | 0.66 | 0.5 | 0.41 | 1 | 0.5 | 1934 | 0/4 |
| jina | 0.63 | 0.75 | 0.19 | 0.75 | 0.69 | 19107 | 1/4 |
| querit | 0.51 | 0.25 | 0.06 | 1 | 1 | 1229 | 0/4 |
| linkup | 0.35 | 0 | 0 | 1 | 0 | 1151 | 0/4 |

### en/web:official
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| exa | 0.93 | 1 | 0.92 | 1 | 0.18 | 1814 | 0/5 |
| brave | 0.90 | 1 | 0.55 | 1 | 0.75 | 666 | 0/5 |
| you | 0.90 | 1 | 0.55 | 1 | 0.75 | 639 | 0/5 |
| querit | 0.89 | 1 | 0.49 | 1 | 1 | 1261 | 0/5 |
| tinyfish | 0.89 | 1 | 0.57 | 1 | 0.6 | 1183 | 0/5 |
| jina | 0.89 | 1 | 0.57 | 1 | 0.57 | 4437 | 0/5 |
| serper | 0.89 | 1 | 0.55 | 1 | 0.55 | 1592 | 0/5 |
| parallel | 0.88 | 1 | 0.81 | 1 | 0.03 | 801 | 0/5 |
| tavily | 0.87 | 1 | 0.62 | 1 | 0 | 1805 | 0/5 |
| anysearch | 0.83 | 1 | 0.25 | 1 | 0.63 | 2264 | 0/5 |
| linkup | 0.46 | 0.2 | 0.15 | 1 | 0 | 982 | 0/5 |

### en/news
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| you-news | 0.94 | 1 | 0.63 | 1 | 1 | 627 | 0/3 |
| exa-news | 0.83 | 1 | 0.64 | 1 | 1 | 8398 | 0/3 |
| brave-news | 0.80 | 0.67 | 0.33 | 1 | 1 | 442 | 0/3 |
| tavily-news | 0.69 | 0.33 | 0.29 | 1 | 1 | 1324 | 0/3 |
| parallel-news | 0.69 | 1 | 0.58 | 1 | 0.32 | 797 | 0/3 |
| serper-news | 0.63 | 0.67 | 0.21 | 1 | 0.67 | 1186 | 0/3 |
| linkup | 0.25 | 0 | 0 | 1 | 0 | 835 | 0/3 |

### en/scholar
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| exa-pdf | 0.93 | 1 | 0.77 | 1 | 0.73 | 1722 | 0/3 |
| exa | 0.92 | 1 | 0.73 | 1 | 0.73 | 2253 | 0/3 |
| parallel | 0.91 | 1 | 0.74 | 1 | 0.53 | 699 | 0/3 |
| you | 0.90 | 1 | 0.58 | 1 | 0.71 | 741 | 0/3 |
| anysearch-academic | 0.85 | 1 | 0.42 | 1 | 0.29 | 2162 | 0/3 |
| serper-scholar | 0.74 | 0.67 | 0.38 | 1 | 0.96 | 1027 | 0/3 |
| tavily | 0.71 | 0.67 | 0.46 | 1 | 0 | 1917 | 0/3 |

### en/code
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| exa-github | 0.96 | 1 | 1 | 1 | 0.17 | 2545 | 0/3 |
| parallel | 0.88 | 1 | 0.81 | 1 | 0.1 | 812 | 0/3 |
| serper | 0.86 | 1 | 0.33 | 1 | 0.79 | 1034 | 0/3 |
| tinyfish | 0.85 | 1 | 0.33 | 1 | 0.75 | 1390 | 0/3 |
| exa | 0.85 | 1 | 0.56 | 1 | 0.27 | 1400 | 0/3 |
| anysearch | 0.85 | 1 | 0.29 | 1 | 0.75 | 3248 | 0/3 |
| querit | 0.74 | 0.67 | 0.38 | 1 | 1 | 1139 | 0/3 |
| tavily | 0.67 | 0.67 | 0.25 | 1 | 0 | 2024 | 0/3 |
| brave | 0.56 | 0.33 | 0.21 | 1 | 0.71 | 677 | 0/3 |
| you | 0.56 | 0.33 | 0.17 | 1 | 0.79 | 630 | 0/3 |
| linkup | 0.36 | 0 | 0.04 | 1 | 0 | 1019 | 0/3 |
| jina | 0.30 | 0.33 | 0.17 | 0.33 | 0.25 | 11304 | 2/3 |

### zh/web:general
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| brave | 0.92 | 1 | 0.73 | 0.98 | 0.46 | 623 | 0/7 |
| brave-zh | 0.91 | 1 | 0.7 | 0.98 | 0.55 | 476 | 0/7 |
| serper-zh | 0.91 | 1 | 0.68 | 1 | 0.48 | 1356 | 0/7 |
| you | 0.90 | 1 | 0.64 | 0.98 | 0.48 | 597 | 0/7 |
| tinyfish | 0.89 | 1 | 0.59 | 1 | 0.5 | 1171 | 0/7 |
| serper | 0.89 | 1 | 0.59 | 1 | 0.5 | 1106 | 0/7 |
| anysearch | 0.89 | 1 | 0.57 | 1 | 0.43 | 2931 | 0/7 |
| parallel | 0.88 | 1 | 0.79 | 0.78 | 0.42 | 759 | 0/7 |
| exa | 0.82 | 0.86 | 0.7 | 0.84 | 0.62 | 1375 | 0/7 |
| linkup | 0.63 | 0.57 | 0.28 | 1 | 0 | 974 | 0/7 |
| jina | 0.61 | 0.71 | 0.36 | 0.62 | 0.34 | 14725 | 2/7 |
| querit | 0.61 | 0.71 | 0.32 | 0.07 | 1 | 1164 | 0/7 |
| tavily | 0.59 | 0.43 | 0.34 | 1 | 0 | 2415 | 0/7 |

### zh/web:exact
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| brave-zh | 0.89 | 1 | 0.63 | 0.94 | 0.56 | 543 | 0/2 |
| serper-zh | 0.88 | 1 | 0.56 | 0.88 | 0.75 | 1737 | 0/2 |
| tinyfish | 0.87 | 1 | 0.5 | 0.88 | 0.81 | 1419 | 0/2 |
| serper | 0.87 | 1 | 0.5 | 0.88 | 0.81 | 2656 | 0/2 |
| anysearch | 0.84 | 1 | 0.38 | 0.81 | 0.81 | 2478 | 0/2 |
| you | 0.80 | 1 | 0.38 | 0.56 | 0.75 | 797 | 0/2 |
| brave | 0.80 | 1 | 0.38 | 0.56 | 0.75 | 757 | 0/2 |
| parallel | 0.76 | 1 | 0.34 | 0.48 | 0.67 | 714 | 0/2 |
| tavily | 0.60 | 0.5 | 0.5 | 0.69 | 0 | 3114 | 0/2 |
| linkup | 0.52 | 0.5 | 0.25 | 0.44 | 0 | 999 | 0/2 |
| exa | 0.35 | 0 | 0.19 | 0.5 | 0.75 | 1389 | 0/2 |
| querit | 0.25 | 0 | 0.06 | 0 | 1 | 1230 | 0/2 |
| jina | 0.00 | 0 | 0 | 0 | 0 | - | 2/2 |

### zh/web:official
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| exa | 0.92 | 1 | 0.81 | 1 | 0.33 | 2016 | 0/4 |
| serper-zh | 0.88 | 1 | 0.63 | 1 | 0.16 | 1870 | 0/4 |
| parallel | 0.87 | 1 | 0.75 | 0.84 | 0.3 | 813 | 0/4 |
| tinyfish | 0.84 | 1 | 0.45 | 1 | 0.22 | 1423 | 0/4 |
| serper | 0.84 | 1 | 0.45 | 1 | 0.22 | 1741 | 0/4 |
| anysearch | 0.83 | 1 | 0.38 | 1 | 0.13 | 2737 | 0/4 |
| brave-zh | 0.77 | 0.75 | 0.59 | 0.91 | 0.25 | 537 | 0/4 |
| brave | 0.73 | 0.75 | 0.47 | 0.81 | 0.25 | 529 | 0/4 |
| you | 0.71 | 0.75 | 0.41 | 0.81 | 0.19 | 789 | 0/4 |
| tavily | 0.71 | 0.75 | 0.42 | 0.97 | 0 | 3657 | 0/4 |
| jina | 0.61 | 0.75 | 0.29 | 0.68 | 0.1 | 12611 | 1/4 |
| linkup | 0.56 | 0.5 | 0.1 | 1 | 0 | 1158 | 0/4 |
| querit | 0.55 | 0.5 | 0.29 | 0.34 | 1 | 1208 | 0/4 |

### zh/news
| variant | score | gold@3 | gold share | lang | dated | p50 ms | errors |
|---|---|---|---|---|---|---|---|
| you-news | 0.77 | 0.67 | 0.21 | 0.88 | 1 | 679 | 0/3 |
| exa-news | 0.71 | 0.67 | 0.46 | 0.96 | 0.88 | 8465 | 0/3 |
| serper-news-zh | 0.68 | 0.33 | 0.21 | 1 | 1 | 1747 | 0/3 |
| tavily-news | 0.67 | 0.33 | 0.17 | 1 | 1 | 2443 | 0/3 |
| brave-news-zh | 0.67 | 0.33 | 0.13 | 1 | 1 | 415 | 0/3 |
| serper-news | 0.66 | 0.33 | 0.08 | 1 | 1 | 1252 | 0/3 |
| brave-news | 0.66 | 0.33 | 0.04 | 1 | 1 | 415 | 0/3 |
| parallel-news | 0.53 | 0.67 | 0.29 | 1 | 0.17 | 1203 | 0/3 |
| linkup | 0.51 | 0.67 | 0.42 | 1 | 0 | 1074 | 0/3 |


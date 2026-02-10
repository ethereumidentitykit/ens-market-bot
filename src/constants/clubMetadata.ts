/**
 * Club metadata mappings for Grails API club slugs.
 * Maps API slugs to display names and Twitter handles.
 */

export const CLUB_LABELS: Record<string, string> = {
  prepunks: 'Prepunk',
  '10k': '10k Club',
  pokemon: 'Pokemon',
  '1kforenames': '1k First Names',
  '1ksurnames': '1k Last Names',
  '999': '999 Club',
  single_ethmoji: 'Single Ethmoji',
  triple_ethmoji: 'Triple Ethmoji',
  ethmoji_99: 'Ethmoji 99',
  ethmoji_999: 'Ethmoji 999',
  base_single_ethmoji: 'Base Single Ethmoji',
  prepunk_100: 'Prepunk 100',
  prepunk_1k: 'Prepunk 1k',
  prepunk_10k: 'Prepunk 10k',
  un_capital_cities: 'UN Capital Cities',
  un_countries: 'UN Countries',
  bip_39: 'BIP 39',
  periodic_table: 'Periodic Table',
  english_adjectives: 'English Adjectives',
  wikidata_top_nouns: 'Top Nouns',
  top_nouns: 'Top Nouns',
  wikidata_top_fantasy_char: 'Top Fantasy',
  '3_letter_palindromes': '3 Letter Palindromes',
  '3_digit_palindromes': '3 Digit Palindromes',
  '4_digit_palindromes': '4 Digit Palindromes',
  '5_digit_palindromes': '5 Digit Palindromes',
  '6_digit_palindromes': '6 Digit Palindromes',
  '100k_club': '100k Club',
  double_ethmoji: 'Double Ethmoji',
  double_triple_digits: 'Double Triple Digits',
  ethmoji_10k: 'Ethmoji 10k',
  prepunk_digits: 'Prepunk Digits',
  quad_ethmoji: 'Quad Ethmoji',
  quint_ethmoji: 'Quint Ethmoji',
  top_crypto_names: 'Top Crypto Names',
  top_crypto_tickers: 'Top Crypto Tickers',
  top_cities_global: 'Top Cities Global',
  top_cities_usa: 'Top Cities USA',
  us_states: 'US States',
  common_animals: 'Animals',
  common_english: 'Common English',
  country_codes: 'Country Codes',
  gamertags: 'Gamertags',
  gamertags_double: 'Gamertags Double',
  crypto_terms: 'Crypto Words',
  social_handles: 'Handles',
  pokemon_gen1: 'Pokemon Gen 1',
  pokemon_gen2: 'Pokemon Gen 2',
  pokemon_gen3: 'Pokemon Gen 3',
  pokemon_gen4: 'Pokemon Gen 4',
  familynames_usa: 'Surnames USA',
  firstnames_usa: 'First Names USA',
  mythical_creatures: 'Mythical Creatures',
  ai_words: 'AI Words',
  catholicism: 'Catholicism',
  crayola_classic: 'Classic Crayola',
  holidays: 'Holidays',
  instruments: 'Instruments',
  personas: 'Personas',
};

export const CLUB_TWITTER_HANDLES: Record<string, string> = {
  prepunks: '@PrePunkOfficial',
  prepunk_100: '@PrePunkOfficial',
  prepunk_1k: '@PrePunkOfficial',
  prepunk_10k: '@PrePunkOfficial',
  prepunk_digits: '@PrePunkOfficial',
  '10k': '@10kClubOfficial',
  pokemon: '@PokemonENS',
  pokemon_gen1: '@PokemonENS',
  pokemon_gen2: '@PokemonENS',
  pokemon_gen3: '@PokemonENS',
  pokemon_gen4: '@PokemonENS',
  '999': '@ens999club',
  base_single_ethmoji: '@EthmojiClub',
  single_ethmoji: '@EthmojiClub',
  triple_ethmoji: '@EthmojiClub',
  double_ethmoji: '@EthmojiClub',
  quad_ethmoji: '@EthmojiClub',
  quint_ethmoji: '@EthmojiClub',
  ethmoji_10k: '@EthmojiClub',
  ethmoji_999: '@Ethmoji999',
  ethmoji_99: '@Ethmoji99',
};

/**
 * Get the display label for a club slug.
 */
export function getClubLabel(slug: string): string {
  return CLUB_LABELS[slug] || slug;
}

/**
 * Get the Twitter handle for a club slug.
 */
export function getClubHandle(slug: string): string | null {
  return CLUB_TWITTER_HANDLES[slug] || null;
}

/**
 * Format clubs array into a display string.
 * Returns first club's label, or null if no clubs.
 */
export function formatClubsString(clubs: string[]): string | null {
  if (!clubs || clubs.length === 0) return null;
  // Return the first club's label
  return getClubLabel(clubs[0]);
}

/**
 * Get the first Twitter handle from a list of clubs.
 */
export function getFirstClubHandle(clubs: string[]): string | null {
  if (!clubs || clubs.length === 0) return null;
  for (const slug of clubs) {
    const handle = getClubHandle(slug);
    if (handle) return handle;
  }
  return null;
}


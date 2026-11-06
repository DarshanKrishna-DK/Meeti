import { storeColumns } from './store-columns';

/** Translate only the application's fixed SQL dialect. Values always remain bound parameters. */
export function postgresSql(input: string): string {
  let text = input.trim(), ignore = false;
  if (/^INSERT\s+OR\s+IGNORE\s+/i.test(text)) { ignore = true; text = text.replace(/^INSERT\s+OR\s+IGNORE\s+/i, 'INSERT '); }
  text = text.replace(/\bINSERT\s+INTO\s+([a-z_]+)\s+VALUES\b/i, (match, table: string) => {
    const columns = storeColumns[table];
    if (!columns) throw new Error('database_unknown_insert_table');
    return `INSERT INTO ${table} (${columns.join(',')}) VALUES`;
  });
  let result = '', parameter = 0, quote = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      result += character;
      if (character === quote) {
        if (text[index + 1] === quote) { result += text[++index]; } else quote = '';
      }
    } else if (character === "'" || character === '"') { quote = character; result += character; }
    else if (character === '?') result += `$${++parameter}`;
    else if (/^rowid\b/i.test(text.slice(index)) && (index === 0 || !/[a-z0-9_]/i.test(text[index - 1]))) { result += '__row_order'; index += 4; }
    else result += character;
  }
  if (quote) throw new Error('database_unterminated_sql_literal');
  if (ignore) result = `${result.replace(/;$/, '')} ON CONFLICT DO NOTHING`;
  return result;
}

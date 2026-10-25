/** Short caption pages shared by speech playback and the island. */
export function captionPhrases(text: string): { text: string; start: number }[] {
  const words = [...text.matchAll(/\S+/g)];
  const phrases: { text: string; start: number }[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?]$/.test(words[i][0]) || i - first >= 11 || i === words.length - 1) {
      const start = words[first].index!;
      phrases.push({ text: text.slice(start, words[i].index! + words[i][0].length), start });
      first = i + 1;
    }
  }
  return phrases;
}
export function currentCaption(text: string, charIndex: number): string {
  if (charIndex < 0) return "";
  const phrase = [...captionPhrases(text)].reverse().find(item => item.start <= charIndex);
  if (!phrase) return "";
  const words = [...phrase.text.matchAll(/\S+/g)].filter(word => phrase.start + word.index! <= charIndex);
  return words.map(word => word[0]).join(" ");
}

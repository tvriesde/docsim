import { describe, expect, it } from 'vitest';
import { detectLanguage, normalizeLanguage } from '../src/lib/language.js';

describe('detectLanguage', () => {
  it('detects common languages', () => {
    expect(
      detectLanguage(
        'The policy holder shall notify the insurer of any change in the risk. This is required for all contracts and the premium will be adjusted by the insurer in line with the terms of the policy.',
      ),
    ).toBe('en');
    expect(
      detectLanguage(
        'De verzekeringnemer is verplicht om een wijziging van het risico te melden. Dit geldt voor alle contracten en de premie wordt door de verzekeraar aangepast in overeenstemming met de voorwaarden van de polis.',
      ),
    ).toBe('nl');
    expect(
      detectLanguage(
        'Der Versicherungsnehmer ist verpflichtet, jede Änderung des Risikos mitzuteilen. Dies gilt für alle Verträge und die Prämie wird von dem Versicherer entsprechend den Bedingungen der Police angepasst und auch geprüft.',
      ),
    ).toBe('de');
    expect(
      detectLanguage(
        "Le preneur d'assurance est tenu de déclarer toute modification du risque. Cela est valable pour tous les contrats et la prime est ajustée par l'assureur selon les conditions de la police dans le cadre du contrat.",
      ),
    ).toBe('fr');
  });

  it('returns und for short or ambiguous text', () => {
    expect(detectLanguage('ABC-123 4.5 kW')).toBe('und');
  });

  it('normalizes LLM language codes', () => {
    expect(normalizeLanguage('NL')).toBe('nl');
    expect(normalizeLanguage(' en ')).toBe('en');
    expect(normalizeLanguage('Dutch')).toBeUndefined();
    expect(normalizeLanguage(3)).toBeUndefined();
  });
});

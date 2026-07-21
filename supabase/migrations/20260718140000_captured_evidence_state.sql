-- Direct observations from a public page are captured source material. They do not need an
-- individual human review unless they are uncertain or being used in an external decision.
alter type public.evidence_state add value if not exists 'captured';

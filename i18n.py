"""
Deadline-Radar i18n: keyed English source-of-truth + Spanish translations,
Phase A rollout (2026-08-19, Devin's direct go-ahead in an RC session).

Design (full writeup: Orchestrator/outbox/assetlab.md, 2026-08-19T13:20 entry):
  - EN is the single source of truth. generate.py's render functions call
    t(key, lang) instead of hardcoding literal English -- this is the ONLY
    place English UI/marketing copy should live once a page is converted.
  - Every EN string has a content hash. A Spanish translation records the
    hash of the EN string it was translated FROM (en_hash). If the English
    string changes later, the stored hash no longer matches -- t() detects
    this and falls back to English rather than ever showing a stale
    translation silently.
  - A translation only ships in Spanish once `reviewed: True` -- this is
    set by a human/AuditLab step, never by whichever agent drafted it (see
    scripts/es_translation_review.py). A freshly (re)drafted translation is
    always reviewed=False until that happens, and t() falls back to
    English for it exactly like a missing translation -- "no unreviewed
    Spanish string ever shows to a real visitor" is enforced by this
    fallback, not by convention.
  - Proper nouns (SITE_NAME, BRAND_NAME) and pure data (counts, dates,
    citation text) are never put in EN/ES directly -- they are passed as
    format() kwargs at call time, same word in every language.

Scope note: only Phase A (UI chrome + top marketing pages) uses this
module. The 55 state data pages (citations, computed dates, legal
consequences) are explicitly NOT in scope until a review-capacity
decision is made -- see the plan doc.
"""

from __future__ import annotations

import hashlib


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# EN: the source of truth. Every string a Phase A page renders to a reader
# (nav labels, footer links/headings, page prose) lives here, keyed by a
# "section.name" identifier. {placeholders} are str.format() fields filled
# in by the caller with proper nouns/numbers/dates -- never translated text.
# ---------------------------------------------------------------------------
EN: dict[str, str] = {
    # Shared chrome -- site_header()
    "site.tagline": "CPA license renewal deadlines by state — verified and kept current",
    "nav.browse_states": "Browse States",
    "nav.how_we_verify": "How We Verify",
    "nav.guides": "Guides",
    "nav.for_firms": "For Firms",
    "nav.live_demo": "Live Demo",
    "nav.sign_in": "Sign In",
    "nav.get_reminders": "Get reminders",
    "nav.dashboard": "Dashboard",  # client-side JS swap once a firm session is detected
    # Shared chrome -- site_footer()
    "footer.heading_data_method": "Data & Method",
    "footer.link_mobility_rule_changes": "Mobility Rule Changes",
    "footer.link_practice_privilege_check": "Practice Privilege Check",
    "footer.link_multi_state_firms": "Multi-State Firms",
    "footer.heading_product": "Product",
    "footer.link_all_jurisdictions": "All {count} jurisdictions",
    "footer.link_pricing": "Pricing",
    "footer.link_deadline_calculator": "Deadline Calculator",
    "footer.link_cpe_vs_license": "CPE vs. License Renewal",
    "footer.link_roadmap": "Roadmap",
    "footer.heading_company": "Company",
    "footer.link_contact": "Contact",
    "footer.link_security": "Security",
    "footer.link_status": "Status",
    "footer.link_terms": "Terms",
    "footer.link_privacy": "Privacy",
    "footer.trust_chip": "No ad or social trackers. Cookieless analytics only.",
    # Split at the original HTML's exact <strong>...</strong> boundary (only
    # the first sentence is bold) so the markup lives in generate.py, not
    # embedded inside translatable text.
    "footer.disclaimer_bold": "{site_name} is an independent reminder service operated by {brand_name}.",
    "footer.disclaimer_rest": (
        "It is not affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state "
        "board of accountancy. Renewal dates are compiled from public sources for informational "
        "purposes only — not legal, tax, or professional advice. Always confirm your exact renewal "
        "date with your state board or on your license."
    ),
    # /methodology/ -- build_methodology_page()
    "methodology.title": "How We Verify Every Deadline",
    # The "{verified_recent} of {total}" lead-in is bolded in generate.py,
    # OUTSIDE this string (matches the original's <strong> boundary around
    # just the two numbers) -- this key is the sentence that follows it.
    "methodology.freshness_stat": (
        "dated records across this site's datasets (renewal deadlines, "
        "CPE hours, reinstatement, renewal fees) were individually re-checked against their source "
        "within the last {threshold_days} days, as of this page's last build ({build_date}). Every "
        "state page's own “Last verified” line shows that specific citation's own date — "
        "this is the same fact, rolled up across the whole site."
    ),
    "methodology.intro": (
        "CPAs are trained to be skeptical of unverified sources — so here is exactly how this "
        "site's dates are sourced, checked, and kept current. Nothing below is aspirational; it "
        "describes the actual standard already applied to every state page."
    ),
    "methodology.h2_two_source_rule": "The two-source rule",
    "methodology.two_source_intro": "Every date on this site must trace to two independent things before it's published:",
    # Inline <strong> emphasis is part of these two strings deliberately
    # (matches the original hand-written HTML) -- a translation must
    # preserve the tags, not just the words.
    "methodology.two_source_item1": (
        "<strong>The state board's own page</strong> — the plain-English source most people would "
        "find first."
    ),
    "methodology.two_source_item2": (
        "<strong>The actual codified statute or administrative rule</strong> the board's requirement "
        "derives from — not a summary of it, the primary legal text itself. That citation and a "
        "direct link to it are shown under every verified date on this site, labeled “Source of "
        "record.”"
    ),
    "methodology.two_source_fallback": (
        "If we can't find or confirm the second source, the date is not published as a confirmed "
        "fact. Instead the page says so plainly and points you to the official state board to "
        "determine your own exact deadline — we do not guess, interpolate, or infer a date we "
        "can't back up with primary law."
    ),
    "methodology.h2_verified_badge": "What the “Verified” badge means",
    "methodology.verified_badge_body": (
        "A callout shows a <strong>Verified</strong> badge only when that specific date has a real "
        "citation to codified law behind it, checked the way described above. A record without one "
        "never shows the badge — there is no in-between state where a date looks confirmed but isn't."
    ),
    "methodology.h2_last_verified": "What “Last verified” means",
    "methodology.last_verified_intro": (
        "The date shown in each state's trust line is the last time we directly re-checked that "
        "state's citation against the primary source text — not just re-read our own notes about "
        "it. We periodically re-run an automated check across every cited source looking for two "
        "things:"
    ),
    "methodology.last_verified_item1": "a broken or redirected link, or",
    "methodology.last_verified_item2": "any sign the underlying rule has since been amended.",
    "methodology.last_verified_followup": (
        "When either turns up, we re-verify by hand before changing anything a visitor sees — an "
        "automated flag never silently rewrites a published date by itself."
    ),
    "methodology.h2_fall_short": "Where this can still fall short, honestly",
    "methodology.fall_short_body": (
        "Some sources are genuinely harder to verify by automated means — a handful of citations "
        "point to PDF documents or JavaScript-rendered pages our tooling can't text-extract "
        "automatically. Where that's the case, those citations were still individually confirmed by "
        "hand at the time they were published; we disclose the tooling gap rather than pretend an "
        "easier check covers it. If a rule changes between our checks, use the contact link below to "
        "flag it and we'll re-verify and correct it quickly."
    ),
    "methodology.h2_what_we_dont_verify": "What we don't verify this way",
    "methodology.dont_verify_body": (
        "CPE hour completion is self-reported wherever this site or its firm tier ever discusses it "
        "— we label that clearly and never give it the same “Verified” treatment as a "
        "sourced renewal date. We also don't independently verify a state's future policy changes; if "
        "a state proposes a new rule that hasn't taken effect yet, we wait for it to become the "
        "actual current rule before citing it."
    ),
    "methodology.h2_see_for_yourself": "See it for yourself",
    "methodology.see_for_yourself_body": (
        "Pick any state page and look for the “Source of record” line under its date — "
        "the citation and the “read the rule” link go to the primary legal text, not a "
        "summary. That's the same standard behind every date on this site."
    ),
    "methodology.backlink_changelog": "See exactly what's changed and when →",
    "methodology.backlink_contact": "Found something that looks wrong? Tell us →",
    "methodology.meta_description": (
        "Deadline-Radar's sourcing standard: every CPA license renewal date traces to the state "
        "board's own page plus the actual codified statute or rule behind it — never a guess."
    ),
}


# ---------------------------------------------------------------------------
# ES: Spanish translations. Populated by scripts/es_translation_review.py
# whenever a build detects a missing/stale entry -- never hand-authored
# directly with reviewed=True. See module docstring.
# ---------------------------------------------------------------------------
ES: dict[str, dict] = {
    'footer.disclaimer_bold': {
        "text": '{site_name} es un servicio independiente de recordatorios operado por {brand_name}.',
        "en_hash": '2cb7ec3bc67c1631',
        "reviewed": False,
    },
    'footer.disclaimer_rest': {
        "text": 'No está afiliado, respaldado ni conectado con NASBA, el AICPA, ni ninguna junta estatal de contabilidad. Las fechas de renovación se recopilan de fuentes públicas únicamente con fines informativos — no constituyen asesoría legal, fiscal ni profesional. Confirme siempre su fecha exacta de renovación con la junta de su estado o en su licencia.',
        "en_hash": '1581cbb44a7d7d92',
        "reviewed": False,
    },
    'footer.heading_company': {
        "text": 'Empresa',
        "en_hash": 'de4743c879734dc3',
        "reviewed": False,
    },
    'footer.heading_data_method': {
        "text": 'Datos y método',
        "en_hash": '6c976c3bde81f379',
        "reviewed": False,
    },
    'footer.heading_product': {
        "text": 'Producto',
        "en_hash": 'fb9ef894175c3274',
        "reviewed": False,
    },
    'footer.link_all_jurisdictions': {
        "text": 'Las {count} jurisdicciones',
        "en_hash": '4afea1a2f22c51d4',
        "reviewed": False,
    },
    'footer.link_contact': {
        "text": 'Contacto',
        "en_hash": '2b5c3d26721ae9c3',
        "reviewed": False,
    },
    'footer.link_cpe_vs_license': {
        "text": 'CPE vs. renovación de licencia',
        "en_hash": '6fa789f39949b20c',
        "reviewed": False,
    },
    'footer.link_deadline_calculator': {
        "text": 'Calculadora de fechas límite',
        "en_hash": 'b9e66e3732c7ce9b',
        "reviewed": False,
    },
    'footer.link_mobility_rule_changes': {
        "text": 'Cambios en normas de movilidad',
        "en_hash": 'ac8fe0fb626fff29',
        "reviewed": False,
    },
    'footer.link_multi_state_firms': {
        "text": 'Firmas multiestatales',
        "en_hash": '9c3eae1fe07e81cd',
        "reviewed": False,
    },
    'footer.link_practice_privilege_check': {
        "text": 'Verificación de privilegio de práctica',
        "en_hash": '45adea10b3b47ad0',
        "reviewed": False,
    },
    'footer.link_pricing': {
        "text": 'Precios',
        "en_hash": 'dfe95783edfef791',
        "reviewed": False,
    },
    'footer.link_privacy': {
        "text": 'Privacidad',
        "en_hash": '54a57c3147c49f33',
        "reviewed": False,
    },
    'footer.link_roadmap': {
        "text": 'Hoja de ruta',
        "en_hash": '92375f997ffe65ab',
        "reviewed": False,
    },
    'footer.link_security': {
        "text": 'Seguridad',
        "en_hash": '8f6fb4eb7f42c0e2',
        "reviewed": False,
    },
    'footer.link_status': {
        "text": 'Estado del servicio',
        "en_hash": '920e413c7d411b61',
        "reviewed": False,
    },
    'footer.link_terms': {
        "text": 'Términos',
        "en_hash": 'ede5489964834a51',
        "reviewed": False,
    },
    'footer.trust_chip': {
        "text": 'Sin rastreadores de anuncios ni redes sociales. Solo análisis sin cookies.',
        "en_hash": '961b66a3099b5455',
        "reviewed": False,
    },
    'methodology.backlink_changelog': {
        "text": 'Vea exactamente qué cambió y cuándo →',
        "en_hash": 'e457cf09346c5ba0',
        "reviewed": False,
    },
    'methodology.backlink_contact': {
        "text": '¿Encontró algo que parece incorrecto? Avísenos →',
        "en_hash": '492504b0149705b1',
        "reviewed": False,
    },
    'methodology.dont_verify_body': {
        "text": 'La finalización de horas de CPE es autoinformada dondequiera que este sitio o su nivel para firmas la mencione — lo etiquetamos claramente y nunca le damos el mismo tratamiento de “Verificado” que a una fecha de renovación con fuente. Tampoco verificamos de forma independiente los futuros cambios de política de un estado; si un estado propone una nueva norma que aún no ha entrado en vigor, esperamos a que se convierta en la norma vigente real antes de citarla.',
        "en_hash": 'ab7f4ec75f1ad0ec',
        "reviewed": False,
    },
    'methodology.fall_short_body': {
        "text": 'Algunas fuentes son genuinamente más difíciles de verificar por medios automatizados — un puñado de citas remiten a documentos PDF o páginas renderizadas con JavaScript que nuestras herramientas no pueden extraer automáticamente. Cuando ese es el caso, esas citas fueron confirmadas individualmente a mano en el momento en que se publicaron; revelamos la limitación de la herramienta en lugar de fingir que una verificación más sencilla la cubre. Si una norma cambia entre nuestras verificaciones, use el enlace de contacto abajo para señalarlo y la volveremos a verificar y corregir rápidamente.',
        "en_hash": 'aa7c72c8e46f75e6',
        "reviewed": False,
    },
    'methodology.freshness_stat': {
        "text": 'registros con fecha en los conjuntos de datos de este sitio (fechas límite de renovación, horas de CPE, reincorporación, tarifas de renovación) fueron verificados individualmente contra su fuente en los últimos {threshold_days} días, a la fecha de la última compilación de esta página ({build_date}). La línea “Última verificación” de cada página estatal muestra la fecha propia de esa cita específica — es el mismo dato, agregado para todo el sitio.',
        "en_hash": '1de9b744025d0a3f',
        "reviewed": False,
    },
    'methodology.h2_fall_short': {
        "text": 'Dónde esto todavía puede quedar corto, con honestidad',
        "en_hash": '511cd5c7e3cd89a5',
        "reviewed": False,
    },
    'methodology.h2_last_verified': {
        "text": 'Qué significa “Última verificación”',
        "en_hash": '002ed2b97d962a07',
        "reviewed": False,
    },
    'methodology.h2_see_for_yourself': {
        "text": 'Compruébelo usted mismo',
        "en_hash": 'ccc55589a3e05697',
        "reviewed": False,
    },
    'methodology.h2_two_source_rule': {
        "text": 'La regla de las dos fuentes',
        "en_hash": 'cfd64ad44ece3baa',
        "reviewed": False,
    },
    'methodology.h2_verified_badge': {
        "text": 'Qué significa la insignia “Verificado”',
        "en_hash": '7724212222d01f1a',
        "reviewed": False,
    },
    'methodology.h2_what_we_dont_verify': {
        "text": 'Qué no verificamos de esta manera',
        "en_hash": '1e566dc227fc25f3',
        "reviewed": False,
    },
    'methodology.intro': {
        "text": 'Los CPA están capacitados para ser escépticos ante fuentes no verificadas — así que esto es exactamente cómo se obtienen, verifican y mantienen actualizadas las fechas de este sitio. Nada de lo siguiente es aspiracional; describe el estándar real ya aplicado a cada página estatal.',
        "en_hash": '0394c54d6bb494c9',
        "reviewed": False,
    },
    'methodology.last_verified_followup': {
        "text": 'Cuando aparece cualquiera de los dos, verificamos manualmente antes de cambiar algo que un visitante vea — una alerta automatizada nunca reescribe silenciosamente una fecha publicada por sí sola.',
        "en_hash": '5fe6baed2ba11d6e',
        "reviewed": False,
    },
    'methodology.last_verified_intro': {
        "text": 'La fecha que se muestra en la línea de confianza de cada estado es la última vez que verificamos directamente la cita de ese estado contra el texto de la fuente primaria — no solo releímos nuestras propias notas al respecto. Periódicamente volvemos a ejecutar una verificación automatizada en cada fuente citada, buscando dos cosas:',
        "en_hash": '337ad3176c49636d',
        "reviewed": False,
    },
    'methodology.last_verified_item1': {
        "text": 'un enlace roto o redirigido, o',
        "en_hash": 'ca9718bfa0078007',
        "reviewed": False,
    },
    'methodology.last_verified_item2': {
        "text": 'cualquier indicio de que la norma subyacente haya sido modificada desde entonces.',
        "en_hash": 'ffd2697ad74d2e49',
        "reviewed": False,
    },
    'methodology.meta_description': {
        "text": 'El estándar de verificación de Deadline-Radar: cada fecha de renovación de licencia de CPA remite a la propia página de la junta estatal más el estatuto o norma codificada real detrás de ella — nunca una suposición.',
        "en_hash": '7537769bf17371d3',
        "reviewed": False,
    },
    'methodology.see_for_yourself_body': {
        "text": 'Elija cualquier página estatal y busque la línea “Fuente oficial” debajo de su fecha — la cita y el enlace “leer la norma” llevan al texto legal primario, no a un resumen. Ese es el mismo estándar detrás de cada fecha en este sitio.',
        "en_hash": 'a8ceea4d0a4bee54',
        "reviewed": False,
    },
    'methodology.title': {
        "text": 'Cómo verificamos cada fecha límite',
        "en_hash": '9c23eb5b14479668',
        "reviewed": False,
    },
    'methodology.two_source_fallback': {
        "text": 'Si no podemos encontrar o confirmar la segunda fuente, la fecha no se publica como un hecho confirmado. En su lugar, la página lo indica claramente y le remite a la junta estatal oficial para que determine su fecha límite exacta — no adivinamos, interpolamos ni inferimos una fecha que no podamos respaldar con la ley primaria.',
        "en_hash": 'db14e52be12a036f',
        "reviewed": False,
    },
    'methodology.two_source_intro': {
        "text": 'Toda fecha en este sitio debe remitirse a dos elementos independientes antes de publicarse:',
        "en_hash": '7500c6c8e1eed63c',
        "reviewed": False,
    },
    'methodology.two_source_item1': {
        "text": '<strong>La propia página de la junta estatal</strong> — la fuente en lenguaje sencillo que la mayoría de las personas encontraría primero.',
        "en_hash": 'ae4f97ae377fc2a7',
        "reviewed": False,
    },
    'methodology.two_source_item2': {
        "text": '<strong>El estatuto codificado o la norma administrativa real</strong> de la que se deriva el requisito de la junta — no un resumen, sino el texto legal primario mismo. Esa cita y un enlace directo a ella se muestran debajo de cada fecha verificada en este sitio, con la etiqueta “Fuente oficial”.',
        "en_hash": 'fad15d7df2de1f83',
        "reviewed": False,
    },
    'methodology.verified_badge_body': {
        "text": 'Un recuadro destacado muestra una insignia <strong>Verificado</strong> solo cuando esa fecha específica tiene una cita real a la ley codificada que la respalda, verificada de la manera descrita arriba. Un registro sin ella nunca muestra la insignia — no existe un estado intermedio donde una fecha parezca confirmada sin estarlo.',
        "en_hash": '9133faed51b64a34',
        "reviewed": False,
    },
    'nav.browse_states': {
        "text": 'Explorar estados',
        "en_hash": 'a6c6d2388d99558e',
        "reviewed": False,
    },
    'nav.dashboard': {
        "text": 'Panel de control',
        "en_hash": '67b696468610b879',
        "reviewed": False,
    },
    'nav.for_firms': {
        "text": 'Para firmas',
        "en_hash": '2f38ed7d5ac795a2',
        "reviewed": False,
    },
    'nav.get_reminders': {
        "text": 'Recibir recordatorios',
        "en_hash": 'a2aa9444da3e4a2b',
        "reviewed": False,
    },
    'nav.guides': {
        "text": 'Guías',
        "en_hash": '572cd72feb9a84e0',
        "reviewed": False,
    },
    'nav.how_we_verify': {
        "text": 'Cómo verificamos',
        "en_hash": 'f85fa15963b89714',
        "reviewed": False,
    },
    'nav.live_demo': {
        "text": 'Demo en vivo',
        "en_hash": '1841d3c3a6598770',
        "reviewed": False,
    },
    'nav.sign_in': {
        "text": 'Iniciar sesión',
        "en_hash": 'bcc0bcc9140b0c97',
        "reviewed": False,
    },
    'site.tagline': {
        "text": 'Fechas límite de renovación de licencias de CPA por estado — verificadas y actualizadas',
        "en_hash": 'dd3f728722518b7c',
        "reviewed": False,
    },
}


def t(key: str, lang: str = "en", **kwargs) -> str:
    """Look up EN[key] (lang="en") or its reviewed, non-stale Spanish
    translation (lang="es"), formatting with kwargs. Falls back to English
    for lang="es" when no translation exists, it's stale (EN changed since
    translation), or it hasn't been reviewed yet -- a visitor never sees an
    unreviewed or stale Spanish string, they see correct English instead."""
    if key not in EN:
        raise KeyError(f"unknown i18n key: {key!r}")
    source = EN[key]
    if lang == "es":
        entry = ES.get(key)
        if entry is not None and entry.get("reviewed") and entry.get("en_hash") == _hash(source):
            source = entry["text"]
    return source.format(**kwargs) if kwargs else source


def en_hash(key: str) -> str:
    if key not in EN:
        raise KeyError(f"unknown i18n key: {key!r}")
    return _hash(EN[key])


def stale_or_missing_keys() -> list[str]:
    """Keys whose Spanish translation is missing, stale, or not yet
    reviewed -- the build-time signal for both the AuditLab review-request
    generator and the preship gate."""
    out = []
    for key in EN:
        entry = ES.get(key)
        if entry is None or not entry.get("reviewed") or entry.get("en_hash") != en_hash(key):
            out.append(key)
    return out

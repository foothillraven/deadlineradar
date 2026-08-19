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
    # /contact/ -- build_contact_page()
    "contact.h1": "Contact",
    "contact.intro": "Questions, a correction to a deadline, or anything else — we'd like to hear from you.",
    "contact.h2_email_us": "Email us",
    # Inline <a> links (mailto/security.txt/RFC) are part of this string
    # deliberately -- the surrounding sentence translates, the links and
    # their targets don't. {email_link}/{security_txt_link}/{rfc_link} are
    # pre-built HTML fragments filled in by generate.py, not translated text.
    "contact.email_body": (
        "We read every message and usually reply within a couple of business days. This is a "
        "small, independent project — there's a real person on the other end, not a support "
        "queue. Our address is also published machine-readably at {security_txt_link} per "
        "{rfc_link}."
    ),
    "contact.privacy_policy_link_text": "Privacy Policy",
    "contact.h2_live_chat": "Live chat",
    "contact.live_chat_body": (
        "Prefer to talk it through right now? Starting a chat loads a live-chat widget (Tawk.to) "
        "— it isn't running on this page until you click the button below, so it never sets its "
        "own cookie unless you actually use it. See our {privacy_link} for what that widget does "
        "and doesn't share."
    ),
    "contact.live_chat_button": "Start a live chat",
    "contact.h2_wrong_date": "Spotted a wrong date?",
    "contact.wrong_date_body": (
        "Deadlines are compiled from official state board sources and we work hard to keep them "
        "current, but rules change. If a date looks off, email us the state and what you're "
        "seeing and we'll verify it against the source and fix it fast. Always confirm your exact "
        "deadline with your state board before relying on it."
    ),
    "contact.h2_stop_reminders": "Stop your reminders",
    "contact.stop_reminders_body": (
        "The fastest way to stop reminders is the one-click unsubscribe link at the bottom of any "
        "email we send — it's instant and permanent. You're welcome to email us too."
    ),
    "contact.h2_mailing_address": "Mailing address",
    "contact.meta_description": (
        "Contact Deadline-Radar — questions, deadline corrections, or help with your CPA "
        "license renewal reminders. Email us or start a live chat."
    ),
    # Live-chat button JS states
    "contact.chat_loading": "Loading chat…",
    "contact.chat_loading_hint": "This can take a few seconds on a slow connection.",
    "contact.chat_ready": "Chat loaded — look for the bubble in the corner",
    "contact.chat_slow": "Still connecting — if this doesn't finish in a few more seconds, email us instead: {email}",
    # /multi-state-firms/ -- build_multi_state_firms_page()
    "msf.h1": "Running a Multi-State CPA Firm? Here's the Full Picture.",
    "msf.intro": (
        "A firm with staff licensed or practicing across more than one state has a genuinely "
        "different problem than a single-state firm: knowing where everyone can legally work, "
        "catching it before a rule changes underneath you, and keeping a citation behind every "
        "answer. Three pieces of this site work together for exactly that."
    ),
    "msf.h2_map": "1. Map — see every state your team can practice in",
    "msf.map_body": (
        "A color-coded map of exactly which states your team can practice in today without a "
        "local license, plus a firm-level registration check for attest work where your firm "
        "itself (not just the individual CPA) needs to register. Part of a paid firm plan — "
        "{pricing_link}."
    ),
    "msf.see_plans": "see plans",
    "msf.h2_ppc": "2. Practice Privilege Check — verify before staff take on out-of-state work",
    "msf.ppc_body": (
        "Before a staff CPA takes on work in a state they're not locally licensed in, run the "
        "check: service type, home state, target state, and the answer comes back with the rule "
        "and citation behind it — never a guess. {ppc_link}."
    ),
    "msf.ppc_link_text": "Free for any account, no paid plan required",
    "msf.h2_rule_changes": "3. Rule Changes — a running feed, not a one-time check",
    "msf.rule_changes_body": (
        "A running feed of confirmed and pending changes to interstate CPA mobility rules — "
        "practice privileges, notice/fee requirements, and firm registration — sourced the same "
        "way every date on this site is: a citation to the primary statute or rule where we could "
        "confirm it, and clearly labelled where we could only confirm it against the board's own "
        "page, never a guess. Your firm's own calendar surfaces the changes that actually affect "
        "your roster's states. {feed_link}."
    ),
    "msf.feed_link_text": "See the full public feed",
    "msf.try_demo": "Try the live demo →",
    "msf.new_here_bold": "New to Deadline-Radar?",
    "msf.new_here_rest": (
        "See the {overview_link} for pricing, the whole feature set, and how renewal-date "
        "tracking fits alongside these three."
    ),
    "msf.overview_link_text": "full firm overview",
    "msf.backlink_all_states": "← Back to all states",
    "msf.title": "Multi-State CPA Firms: Map, Mobility Check, and Rule Changes",
    "msf.meta_description": (
        "For a CPA firm with staff across multiple states: a coverage map, a free Practice "
        "Privilege Check, and a running feed of mobility rule changes — all sourced and cited."
    ),
    # /practice-privilege-check/ -- build_practice_privilege_landing_page()
    "ppc.h1": "Practice Privilege Check: Can a CPA Work in Another State Without a License?",
    "ppc.subhead": (
        "Can this CPA provide this service in this state — and what has to happen first? "
        "Every answer is tied to the rule it came from."
    ),
    "ppc.callout_bold": "Informational, not legal advice.",
    "ppc.callout_rest": (
        "Practice-privilege rules change, and they depend on facts we can't see. We show you the "
        "rule and where it came from so you can check it yourself — and where we haven't "
        "verified something against a primary source, we say so instead of guessing. Confirm with "
        "the state board before you rely on any answer here."
    ),
    "ppc.h2_what_it_does": "What Practice Privilege Check actually does",
    "ppc.what_it_does_intro": (
        "A different question from renewal dates: can this CPA provide this specific service in "
        "this specific state right now, without a local license — and what has to happen first?"
    ),
    "ppc.item_pick_service_bold": "Pick a service type:",
    "ppc.item_pick_service_rest": "Tax; Attest (audit, review, or other attest); or Other non-attest (consulting, advisory).",
    "ppc.item_attest_gap_bold": "Watch for the attest gap:",
    "ppc.item_attest_gap_rest": (
        "attest work frequently triggers a firm-registration requirement where tax work doesn't "
        "— that's the most common real-world mobility mistake, and this catches it."
    ),
    "ppc.item_confirm_bold": "What you'll need to confirm:",
    "ppc.item_confirm_rest": (
        "the license is active and in good standing, and the CPA meets substantial equivalence "
        "(150 semester hours, one year of experience, the Uniform CPA Exam). We can't verify "
        "either input ourselves — the answer is only as good as what you tell it, same "
        "honesty standard as every renewal date on this site."
    ),
    "ppc.coverage_body": (
        "Verified in all 55 U.S. jurisdictions today, both for the individual question above and "
        "a separate <strong>firm-level registration check</strong> — does the FIRM itself need to "
        "register somewhere it has no office, even when the individual CPA is covered."
    ),
    "ppc.free_tier_body": (
        "The individual check is free on every tier, for any account — a free signup is all "
        "it takes, no card, no paid plan required. {pricing_link}."
    ),
    "ppc.free_tier_link_text": "The firm-level check and the multistate coverage map are part of a paid plan",
    "ppc.run_check": "Run a free check now →",
    "ppc.tracking_bold": "Tracking a whole firm's roster, not just one lookup?",
    "ppc.tracking_rest": (
        "See the {overview_link} — Roster, Calendar, CPE tracking, and individual Practice "
        "Privilege Check are free there too; paid tiers add the multistate map and the firm-level "
        "registration check. See {pricing_link2}."
    ),
    "ppc.overview_link_text": "firm overview",
    "ppc.full_pricing_link_text": "full pricing",
    "ppc.backlink_all_states": "← Back to all states",
    "ppc.title": "Practice Privilege Check",
    "ppc.meta_description": (
        "What CPA practice privilege (mobility) means, how substantial equivalence works, and how "
        "to check whether a CPA can serve a client in another state without a local license — "
        "free, verified in all 55 U.S. jurisdictions."
    ),
}


# ---------------------------------------------------------------------------
# ES: Spanish translations. Populated by scripts/es_translation_review.py
# whenever a build detects a missing/stale entry -- never hand-authored
# directly with reviewed=True. See module docstring.
# ---------------------------------------------------------------------------
ES: dict[str, dict] = {
    'contact.chat_loading': {
        "text": 'Cargando chat…',
        "en_hash": '043e8f3c0b4c84cb',
        "reviewed": False,
    },
    'contact.chat_loading_hint': {
        "text": 'Esto puede tardar unos segundos en una conexión lenta.',
        "en_hash": '2f83787e261e11b8',
        "reviewed": False,
    },
    'contact.chat_ready': {
        "text": 'Chat cargado — busque la burbuja en la esquina',
        "en_hash": '0c00d0b8e64d3938',
        "reviewed": False,
    },
    'contact.chat_slow': {
        "text": 'Todavía conectando — si esto no termina en unos segundos más, escríbanos en su lugar: {email}',
        "en_hash": '0cb8ac72d543d709',
        "reviewed": False,
    },
    'contact.email_body': {
        "text": 'Leemos cada mensaje y normalmente respondemos en un par de días hábiles. Este es un proyecto pequeño e independiente — hay una persona real del otro lado, no una cola de soporte. Nuestra dirección también se publica de forma legible por máquina en {security_txt_link} según {rfc_link}.',
        "en_hash": '9fd5d0895e10799f',
        "reviewed": False,
    },
    'contact.h1': {
        "text": 'Contacto',
        "en_hash": '2b5c3d26721ae9c3',
        "reviewed": False,
    },
    'contact.h2_email_us': {
        "text": 'Escríbanos',
        "en_hash": 'd9172c43bec620b2',
        "reviewed": False,
    },
    'contact.h2_live_chat': {
        "text": 'Chat en vivo',
        "en_hash": '1c7cc7287ca8090e',
        "reviewed": False,
    },
    'contact.h2_mailing_address': {
        "text": 'Dirección postal',
        "en_hash": '88a4628a726eaebd',
        "reviewed": False,
    },
    'contact.h2_stop_reminders': {
        "text": 'Detenga sus recordatorios',
        "en_hash": '98d3ecda22a1df9f',
        "reviewed": False,
    },
    'contact.h2_wrong_date': {
        "text": '¿Encontró una fecha incorrecta?',
        "en_hash": 'acb84418844b64c5',
        "reviewed": False,
    },
    'contact.intro': {
        "text": 'Preguntas, una corrección a una fecha límite, o cualquier otra cosa — nos gustaría saber de usted.',
        "en_hash": 'ed62b5488c50ce0e',
        "reviewed": False,
    },
    'contact.live_chat_body': {
        "text": '¿Prefiere hablarlo ahora mismo? Iniciar un chat carga un widget de chat en vivo (Tawk.to) — no se ejecuta en esta página hasta que hace clic en el botón de abajo, por lo que nunca establece su propia cookie a menos que realmente lo use. Consulte nuestra {privacy_link} para saber qué comparte ese widget y qué no.',
        "en_hash": 'ec78895078735233',
        "reviewed": False,
    },
    'contact.live_chat_button': {
        "text": 'Iniciar un chat en vivo',
        "en_hash": '379c1f1a5af158e3',
        "reviewed": False,
    },
    'contact.meta_description': {
        "text": 'Contacte a Deadline-Radar — preguntas, correcciones de fechas límite, o ayuda con sus recordatorios de renovación de licencia de CPA. Escríbanos por correo o inicie un chat en vivo.',
        "en_hash": 'deb602834aebfe2f',
        "reviewed": False,
    },
    'contact.privacy_policy_link_text': {
        "text": 'Política de Privacidad',
        "en_hash": '506ff394621596dd',
        "reviewed": False,
    },
    'contact.stop_reminders_body': {
        "text": 'La forma más rápida de detener los recordatorios es el enlace de baja de un clic al final de cualquier correo que enviemos — es instantáneo y permanente. También puede escribirnos por correo.',
        "en_hash": 'ab859a2b560d7439',
        "reviewed": False,
    },
    'contact.wrong_date_body': {
        "text": 'Las fechas límite se recopilan de fuentes oficiales de las juntas estatales y trabajamos arduamente para mantenerlas actualizadas, pero las normas cambian. Si una fecha parece incorrecta, envíenos por correo el estado y lo que está viendo, y la verificaremos contra la fuente y la corregiremos rápidamente. Siempre confirme su fecha límite exacta con la junta de su estado antes de confiar en ella.',
        "en_hash": 'cd5fa637791b647b',
        "reviewed": False,
    },
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
    'msf.backlink_all_states': {
        "text": '← Volver a todos los estados',
        "en_hash": '116d8e518da7ebb0',
        "reviewed": False,
    },
    'msf.feed_link_text': {
        "text": 'Vea el feed público completo',
        "en_hash": 'a6b7dfba7a46fe57',
        "reviewed": False,
    },
    'msf.h1': {
        "text": '¿Dirige una firma de CPA multiestatal? Aquí está el panorama completo.',
        "en_hash": '995b35a40657fce4',
        "reviewed": False,
    },
    'msf.h2_map': {
        "text": '1. Mapa — vea en qué estados puede ejercer todo su equipo',
        "en_hash": 'd9ca0e416bf72b16',
        "reviewed": False,
    },
    'msf.h2_ppc': {
        "text": '2. Verificación de privilegio de práctica — confirme antes de que el personal asuma trabajo fuera del estado',
        "en_hash": '1b970c435bfcdf55',
        "reviewed": False,
    },
    'msf.h2_rule_changes': {
        "text": '3. Cambios de normas — un feed continuo, no una verificación única',
        "en_hash": '24fab8ed43ef3163',
        "reviewed": False,
    },
    'msf.intro': {
        "text": 'Una firma con personal licenciado o ejerciendo en más de un estado tiene un problema genuinamente distinto al de una firma de un solo estado: saber dónde puede trabajar legalmente cada persona, detectarlo antes de que una norma cambie bajo sus pies, y mantener una cita detrás de cada respuesta. Tres piezas de este sitio trabajan juntas exactamente para eso.',
        "en_hash": 'df89adddee99fb48',
        "reviewed": False,
    },
    'msf.map_body': {
        "text": 'Un mapa codificado por colores que muestra exactamente en qué estados su equipo puede ejercer hoy sin una licencia local, más una verificación de registro a nivel de firma para trabajo de certificación donde su propia firma (no solo el CPA individual) necesita registrarse. Parte de un plan de firma de pago — {pricing_link}.',
        "en_hash": 'bf6e29d476fad8f9',
        "reviewed": False,
    },
    'msf.meta_description': {
        "text": 'Para una firma de CPA con personal en varios estados: un mapa de cobertura, una Verificación de privilegio de práctica gratuita, y un feed continuo de cambios de normas de movilidad — todo con fuentes y citas.',
        "en_hash": '2db9cec4bc7c6c31',
        "reviewed": False,
    },
    'msf.new_here_bold': {
        "text": '¿Nuevo en Deadline-Radar?',
        "en_hash": 'a377ab1ca0457c97',
        "reviewed": False,
    },
    'msf.new_here_rest': {
        "text": 'Vea el {overview_link} para precios, el conjunto completo de funciones, y cómo el seguimiento de fechas de renovación encaja junto con estas tres.',
        "en_hash": 'c992446c0c6f005c',
        "reviewed": False,
    },
    'msf.overview_link_text': {
        "text": 'resumen completo para firmas',
        "en_hash": '36f6173bffc454fd',
        "reviewed": False,
    },
    'msf.ppc_body': {
        "text": 'Antes de que un CPA de su equipo asuma trabajo en un estado donde no tiene licencia local, ejecute la verificación: tipo de servicio, estado de origen, estado de destino, y la respuesta llega con la norma y la cita que la respaldan — nunca una suposición. {ppc_link}.',
        "en_hash": 'e92e4be0a06603ba',
        "reviewed": False,
    },
    'msf.ppc_link_text': {
        "text": 'Gratis para cualquier cuenta, sin plan de pago requerido',
        "en_hash": 'e3e7ab62fcddaa42',
        "reviewed": False,
    },
    'msf.rule_changes_body': {
        "text": 'Un feed continuo de cambios confirmados y pendientes a las normas de movilidad interestatal de CPA — privilegios de práctica, requisitos de aviso/tarifa, y registro de firmas — obtenido de la misma manera que cada fecha en este sitio: una cita al estatuto o norma primaria donde pudimos confirmarla, y claramente etiquetado donde solo pudimos confirmarla contra la propia página de la junta, nunca una suposición. El calendario de su propia firma muestra los cambios que realmente afectan a los estados de su equipo. {feed_link}.',
        "en_hash": 'd0fa020ab8c1681b',
        "reviewed": False,
    },
    'msf.see_plans': {
        "text": 'ver planes',
        "en_hash": '70bc8613cdb53212',
        "reviewed": False,
    },
    'msf.title': {
        "text": 'Firmas de CPA multiestatales: mapa, verificación de movilidad y cambios de normas',
        "en_hash": 'df39614c32f5145b',
        "reviewed": False,
    },
    'msf.try_demo': {
        "text": 'Pruebe la demo en vivo →',
        "en_hash": 'f6fe3745b0891272',
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
    'ppc.backlink_all_states': {
        "text": '← Volver a todos los estados',
        "en_hash": '116d8e518da7ebb0',
        "reviewed": False,
    },
    'ppc.callout_bold': {
        "text": 'Informativo, no asesoría legal.',
        "en_hash": '7808cd56162dfcd4',
        "reviewed": False,
    },
    'ppc.callout_rest': {
        "text": 'Las normas de privilegio de práctica cambian, y dependen de hechos que no podemos ver. Le mostramos la norma y de dónde proviene para que pueda verificarla usted mismo — y donde no hemos verificado algo contra una fuente primaria, lo decimos en lugar de adivinar. Confirme con la junta estatal antes de confiar en cualquier respuesta aquí.',
        "en_hash": 'e7572963bd42c96b',
        "reviewed": False,
    },
    'ppc.coverage_body': {
        "text": 'Verificado en las 55 jurisdicciones de EE. UU. hoy, tanto para la pregunta individual de arriba como para una <strong>verificación de registro a nivel de firma</strong> separada — si la FIRMA misma necesita registrarse en algún lugar donde no tiene oficina, incluso cuando el CPA individual está cubierto.',
        "en_hash": '02b1c73e5c9a0836',
        "reviewed": False,
    },
    'ppc.free_tier_body': {
        "text": 'La verificación individual es gratuita en todos los niveles, para cualquier cuenta — un registro gratuito es todo lo que se necesita, sin tarjeta, sin plan de pago requerido. {pricing_link}.',
        "en_hash": '5ec420f51ca1d848',
        "reviewed": False,
    },
    'ppc.free_tier_link_text': {
        "text": 'La verificación a nivel de firma y el mapa de cobertura multiestatal son parte de un plan de pago',
        "en_hash": 'eb07b4dd34ea150b',
        "reviewed": False,
    },
    'ppc.full_pricing_link_text': {
        "text": 'los precios completos',
        "en_hash": 'c2504a2f405b4965',
        "reviewed": False,
    },
    'ppc.h1': {
        "text": 'Verificación de privilegio de práctica: ¿puede un CPA trabajar en otro estado sin licencia?',
        "en_hash": '87a0ea2bc82b5a93',
        "reviewed": False,
    },
    'ppc.h2_what_it_does': {
        "text": 'Qué hace realmente Verificación de privilegio de práctica',
        "en_hash": '59cbfffc71e3cc8c',
        "reviewed": False,
    },
    'ppc.item_attest_gap_bold': {
        "text": 'Cuidado con el vacío de certificación:',
        "en_hash": 'c02136f1660a298a',
        "reviewed": False,
    },
    'ppc.item_attest_gap_rest': {
        "text": 'el trabajo de certificación frecuentemente activa un requisito de registro de firma donde el trabajo de impuestos no lo hace — ese es el error de movilidad más común en la práctica real, y esto lo detecta.',
        "en_hash": '2e8f0a2375570ee1',
        "reviewed": False,
    },
    'ppc.item_confirm_bold': {
        "text": 'Lo que necesitará confirmar:',
        "en_hash": 'c06a9eb3db6624ac',
        "reviewed": False,
    },
    'ppc.item_confirm_rest': {
        "text": 'que la licencia esté activa y en regla, y que el CPA cumpla con la equivalencia sustancial (150 horas semestrales, un año de experiencia, el Examen Uniforme de CPA). No podemos verificar ninguno de los dos datos nosotros mismos — la respuesta es tan buena como lo que usted indique, el mismo estándar de honestidad que cada fecha de renovación en este sitio.',
        "en_hash": '3915218c6b09d85b',
        "reviewed": False,
    },
    'ppc.item_pick_service_bold': {
        "text": 'Elija un tipo de servicio:',
        "en_hash": 'c4d4753c649835d7',
        "reviewed": False,
    },
    'ppc.item_pick_service_rest': {
        "text": 'Impuestos; Certificación (auditoría, revisión, u otra certificación); u Otro no certificado (consultoría, asesoría).',
        "en_hash": '6b98fc4b698f9cf2',
        "reviewed": False,
    },
    'ppc.meta_description': {
        "text": 'Qué significa el privilegio de práctica (movilidad) de CPA, cómo funciona la equivalencia sustancial, y cómo verificar si un CPA puede atender a un cliente en otro estado sin una licencia local — gratis, verificado en las 55 jurisdicciones de EE. UU.',
        "en_hash": '14f9c079ff6173df',
        "reviewed": False,
    },
    'ppc.overview_link_text': {
        "text": 'resumen para firmas',
        "en_hash": '3f6d1dad09e67630',
        "reviewed": False,
    },
    'ppc.run_check': {
        "text": 'Ejecute una verificación gratuita ahora →',
        "en_hash": '7f8c29ac81913ae1',
        "reviewed": False,
    },
    'ppc.subhead': {
        "text": '¿Puede este CPA prestar este servicio en este estado — y qué tiene que suceder primero? Cada respuesta está vinculada a la norma de la que proviene.',
        "en_hash": '5858df5cb22dc3cd',
        "reviewed": False,
    },
    'ppc.title': {
        "text": 'Verificación de privilegio de práctica',
        "en_hash": '45adea10b3b47ad0',
        "reviewed": False,
    },
    'ppc.tracking_bold': {
        "text": '¿Está siguiendo el personal de toda una firma, no solo una consulta?',
        "en_hash": '6d356959f481b6e4',
        "reviewed": False,
    },
    'ppc.tracking_rest': {
        "text": 'Vea el {overview_link} — Roster, Calendario, seguimiento de CPE, y la Verificación de privilegio de práctica individual también son gratis allí; los niveles de pago agregan el mapa multiestatal y la verificación de registro a nivel de firma. Vea {pricing_link2}.',
        "en_hash": 'b7aa7c7b031dda01',
        "reviewed": False,
    },
    'ppc.what_it_does_intro': {
        "text": 'Una pregunta distinta a las fechas de renovación: ¿puede este CPA prestar este servicio específico en este estado específico ahora mismo, sin una licencia local — y qué tiene que suceder primero?',
        "en_hash": '6d90d13b10200e27',
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

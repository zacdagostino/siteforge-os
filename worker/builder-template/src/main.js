/* global IntersectionObserver, document, requestAnimationFrame, window */
'use strict';

(() => {
  const runtimeClass = 'sf-motion-runtime';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const supportsObserver = 'IntersectionObserver' in window;
  const style = document.createElement('style');

  style.textContent = `
    .${runtimeClass} [data-sf-reveal] { opacity: 0; transform: translateY(18px); transition: opacity 480ms ease, transform 480ms ease; transition-delay: var(--sf-motion-delay, 0ms); }
    .${runtimeClass} [data-sf-reveal].is-visible { opacity: 1; transform: translateY(0); }
    .${runtimeClass} [data-sf-title-word] { display: inline-block; opacity: 0; transform: translateY(0.5em); transition: opacity 420ms ease, transform 420ms ease; transition-delay: var(--sf-motion-delay, 0ms); }
    .${runtimeClass} [data-sf-reveal].is-visible [data-sf-title-word] { opacity: 1; transform: translateY(0); }
    @media (prefers-reduced-motion: reduce) { .${runtimeClass} [data-sf-reveal], .${runtimeClass} [data-sf-title-word] { opacity: 1; transform: none; transition: none; } }
  `;
  document.head.append(style);
  document.documentElement.classList.add(runtimeClass);

  const revealCandidates = [
    ...document.querySelectorAll(
      'main > *, main section, main article, main .card, main [data-reveal]',
    ),
  ].filter((element, index, all) => all.indexOf(element) === index && !element.closest('dialog'));

  function wordifyTitle(title) {
    if (title.dataset.sfTitleReady || title.children.length || !title.textContent?.trim()) return;
    const words = title.textContent.trim().split(/\s+/);
    if (words.length > 12) return;
    title.dataset.sfTitleReady = 'true';
    title.replaceChildren(
      ...words.flatMap((word, index) => {
        const span = document.createElement('span');
        span.dataset.sfTitleWord = 'true';
        span.style.setProperty('--sf-motion-delay', `${Math.min(index * 42, 320)}ms`);
        span.textContent = word;
        return index === words.length - 1 ? [span] : [span, document.createTextNode(' ')];
      }),
    );
  }

  function animateCounter(element) {
    const value = Number(element.dataset.counter ?? element.textContent?.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(value)) return;
    const suffix = element.dataset.counterSuffix ?? '';
    const duration = 700;
    const start = performance.now();
    const update = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      element.textContent = `${Math.round(value * progress).toLocaleString()}${suffix}`;
      if (progress < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  revealCandidates.forEach((element, index) => {
    element.dataset.sfReveal = 'true';
    element.style.setProperty('--sf-motion-delay', `${Math.min((index % 5) * 55, 220)}ms`);
    element.querySelectorAll('h1, h2').forEach(wordifyTitle);
  });

  const reveal = (element) => {
    element.classList.add('is-visible');
    element.querySelectorAll('[data-counter]').forEach(animateCounter);
  };

  if (reducedMotion || !supportsObserver) {
    revealCandidates.forEach(reveal);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        reveal(entry.target);
        observer.unobserve(entry.target);
      }),
    { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
  );
  revealCandidates.forEach((element) => observer.observe(element));
})();

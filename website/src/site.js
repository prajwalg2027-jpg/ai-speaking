// Tiny progressive enhancements. The page works fully without this file.
(() => {
  const head = document.querySelector('.site-head');
  const onScroll = () => head && head.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Cycle sample exchanges in the hero bubbles.
  const coach = document.querySelector('#coachBubble span');
  const you = document.querySelector('#youBubble span');
  if (!coach || !you || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const lines = [
    ['Hi! Tell me a little about yourself. English or Hindi, whatever feels comfortable.', 'My name is Priya. I work in a bank and I like walking in the evening.'],
    ["'Paani' ko English mein kya kehte hain?", 'Water!'],
    ['Please read this sentence out loud.', 'Every morning I take the bus to work…'],
    ['If you could change one thing about your city, what would it be?', 'I would add more parks, because people need space to relax.'],
  ];
  let i = 0;
  const bubbles = [coach.parentElement, you.parentElement];
  setInterval(() => {
    bubbles.forEach((b) => b.classList.add('fade'));
    setTimeout(() => {
      i = (i + 1) % lines.length;
      [coach.textContent, you.textContent] = lines[i];
      bubbles[0].classList.remove('fade');
      setTimeout(() => bubbles[1].classList.remove('fade'), 700);
    }, 500);
  }, 5200);
})();

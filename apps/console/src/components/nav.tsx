'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';

/**
 * Grouped by what the reader is doing, not by which component serves it.
 *
 * "Decide" comes first because the hand-off inbox is the surface a controller
 * opens every morning; everything else is reference.
 */
const GROUPS: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: 'Decide',
    items: [
      { href: '/', label: 'Overview' },
      { href: '/handoffs', label: 'Hand-offs' },
    ],
  },
  {
    label: 'Understand',
    items: [
      { href: '/scope-card', label: 'Scope Card' },
      { href: '/registry', label: 'What it may do' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/enrolment', label: 'Enrolment' },
      { href: '/audit', label: 'Audit trail' },
    ],
  },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <div className="nav">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="nav-group">{group.label}</div>
          {group.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                item.href === '/'
                  ? pathname === '/'
                    ? 'page'
                    : undefined
                  : pathname.startsWith(item.href)
                    ? 'page'
                    : undefined
              }
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

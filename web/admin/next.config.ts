import type { NextConfig } from 'next';

const config: NextConfig = {
  // le dépôt ALVEARE est racine du workspace (il y a d'autres lockfiles
  // sur la machine — évite l'inférence Next.js)
  outputFileTracingRoot: __dirname.replace(/\/web\/admin$/, ''),
};

export default config;

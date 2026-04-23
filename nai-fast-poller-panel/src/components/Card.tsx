import React, { ReactNode } from 'react';
import { motion } from 'motion/react';
import { LucideIcon } from 'lucide-react';

interface CardProps {
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  headerExtra?: ReactNode;
  id?: string;
}

export function Card({ title, icon: Icon, children, className = '', headerExtra, id }: CardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={`bg-slate-900 border border-slate-800 rounded-lg overflow-hidden flex flex-col group hover:border-slate-700 transition-colors duration-300 ${className}`}
      id={id}
    >
      {/* Card Header */}
      <div className="bg-slate-800/50 px-4 py-3 flex items-center justify-between border-b border-slate-800 group-hover:bg-slate-800/80 transition-colors">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-slate-300 transition-colors">
            {title}
          </span>
        </div>
        {headerExtra && (
          <div className="flex items-center">
            {headerExtra}
          </div>
        )}
      </div>

      {/* Card Content */}
      <div className="p-4 flex-1">
        {children}
      </div>
    </motion.div>
  );
}

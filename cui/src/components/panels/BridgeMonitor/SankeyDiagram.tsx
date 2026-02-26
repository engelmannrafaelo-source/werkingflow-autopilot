import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { sankey, sankeyLinkHorizontal, SankeyNode, SankeyLink } from 'd3-sankey';

interface SankeyData {
  nodes: { name: string; category: 'user' | 'app' | 'model' | 'provider' }[];
  links: { source: number; target: number; value: number }[];
}

interface Props {
  data: SankeyData;
  width?: number;
  height?: number;
}

export default function SankeyDiagram({ data, width = 800, height = 400 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const margin = { top: 10, right: 10, bottom: 10, left: 10 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create sankey generator
    const sankeyGenerator = sankey<SankeyNode<any, any>, SankeyLink<any, any>>()
      .nodeWidth(15)
      .nodePadding(10)
      .extent([
        [0, 0],
        [innerWidth, innerHeight],
      ]);

    // Generate the sankey diagram
    const { nodes, links } = sankeyGenerator({
      nodes: data.nodes.map((d) => ({ ...d })),
      links: data.links.map((d) => ({ ...d })),
    });

    // Color scale by category
    const colorScale: Record<string, string> = {
      user: 'var(--tn-blue)',
      app: 'var(--tn-purple, #bb9af7)',
      model: 'var(--tn-orange)',
      provider: 'var(--tn-green)',
    };

    // Draw links
    g.append('g')
      .selectAll('path')
      .data(links)
      .join('path')
      .attr('d', sankeyLinkHorizontal())
      .attr('stroke', (d: any) => {
        const sourceNode = nodes[d.source.index] as any;
        return colorScale[sourceNode.category] || 'var(--tn-text-muted)';
      })
      .attr('stroke-width', (d: any) => Math.max(1, d.width))
      .attr('fill', 'none')
      .attr('opacity', 0.3)
      .on('mouseenter', function () {
        d3.select(this).attr('opacity', 0.6);
      })
      .on('mouseleave', function () {
        d3.select(this).attr('opacity', 0.3);
      })
      .append('title')
      .text((d: any) => {
        const sourceNode = nodes[d.source.index] as any;
        const targetNode = nodes[d.target.index] as any;
        return `${sourceNode.name} → ${targetNode.name}\n${d.value.toLocaleString()} tokens`;
      });

    // Draw nodes
    const nodeGroup = g
      .append('g')
      .selectAll('g')
      .data(nodes)
      .join('g');

    nodeGroup
      .append('rect')
      .attr('x', (d: any) => d.x0)
      .attr('y', (d: any) => d.y0)
      .attr('height', (d: any) => d.y1 - d.y0)
      .attr('width', (d: any) => d.x1 - d.x0)
      .attr('fill', (d: any) => colorScale[d.category] || 'var(--tn-text-muted)')
      .attr('opacity', 0.8)
      .on('mouseenter', function () {
        d3.select(this).attr('opacity', 1);
      })
      .on('mouseleave', function () {
        d3.select(this).attr('opacity', 0.8);
      })
      .append('title')
      .text((d: any) => `${d.name}\n${d.value.toLocaleString()} tokens`);

    // Add text labels
    nodeGroup
      .append('text')
      .attr('x', (d: any) => (d.x0 < innerWidth / 2 ? d.x1 + 6 : d.x0 - 6))
      .attr('y', (d: any) => (d.y1 + d.y0) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (d: any) => (d.x0 < innerWidth / 2 ? 'start' : 'end'))
      .attr('fill', 'var(--tn-text)')
      .attr('font-size', '10px')
      .text((d: any) => d.name);
  }, [data, width, height]);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{ background: 'var(--tn-bg-dark)', borderRadius: 6 }}
    />
  );
}

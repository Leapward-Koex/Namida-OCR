export interface SelectionRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export class SnipOverlay {
    private overlay: HTMLDivElement;
    private selectionBox: HTMLDivElement;
    private isSnipping: boolean = false;
    private startX: number = 0;
    private startY: number = 0;
    private currentX: number = 0;
    private currentY: number = 0;
    private onSelectionComplete: (rect: SelectionRect) => void;

    constructor(onSelectionComplete: (rect: SelectionRect) => void) {
        this.onSelectionComplete = onSelectionComplete;
        this.overlay = this.createOverlay();
        this.selectionBox = this.createSelectionBox();
        this.overlay.appendChild(this.selectionBox);
    }

    private createOverlay(): HTMLDivElement {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0px';
        overlay.style.left = '0px';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.cursor = 'crosshair';
        overlay.style.zIndex = '999999';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        return overlay;
    }

    private createSelectionBox(): HTMLDivElement {
        const box = document.createElement('div');
        box.style.position = 'absolute';
        box.style.border = '2px dashed #fff';
        box.style.background = 'rgba(255, 255, 255, 0.3)';
        box.style.display = 'none';
        return box;
    }

    public show() {
        if (this.isSnipping) return;
        document.body.appendChild(this.overlay);
        this.isSnipping = true;

        // Set up event listeners
        this.overlay.addEventListener('mousedown', this.startSelection);
        this.overlay.addEventListener('mousemove', this.updateSelection);
        this.overlay.addEventListener('mouseup', this.endSelection);
    }

    public hide() {
        if (!this.isSnipping) return;
        // Remove event listeners
        this.overlay.removeEventListener('mousedown', this.startSelection);
        this.overlay.removeEventListener('mousemove', this.updateSelection);
        this.overlay.removeEventListener('mouseup', this.endSelection);
        document.body.removeChild(this.overlay);
        this.selectionBox.style.display = 'none';
        this.isSnipping = false;
    }

    private startSelection = (e: MouseEvent) => {
        e.preventDefault();
        this.startX = e.clientX;
        this.startY = e.clientY;

        this.selectionBox.style.display = 'block';
        this.selectionBox.style.left = `${this.startX}px`;
        this.selectionBox.style.top = `${this.startY}px`;
        this.selectionBox.style.width = '0px';
        this.selectionBox.style.height = '0px';
    }

    private updateSelection = (e: MouseEvent) => {
        if (!this.selectionBox.style.display) return;

        this.currentX = e.clientX;
        this.currentY = e.clientY;

        const width = Math.abs(this.currentX - this.startX);
        const height = Math.abs(this.currentY - this.startY);
        const left = Math.min(this.currentX, this.startX);
        const top = Math.min(this.currentY, this.startY);

        this.selectionBox.style.width = `${width}px`;
        this.selectionBox.style.height = `${height}px`;
        this.selectionBox.style.left = `${left}px`;
        this.selectionBox.style.top = `${top}px`;
    }

    private endSelection = (e: MouseEvent) => {
        if (!this.selectionBox.style.display) return;

        const rect = this.selectionBox.getBoundingClientRect();
        const selection: SelectionRect = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        };

        this.onSelectionComplete(selection);
        this.hide();
    }
}

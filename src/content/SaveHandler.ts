export class SaveHandler {
    public downloadImage(dataURL: string, filename: string = 'snippet.png') {
        const link = document.createElement('a');
        link.href = dataURL;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}
